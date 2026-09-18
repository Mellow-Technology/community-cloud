/**
 * @file
 * Which disks the installer will take, and which it leaves alone.
 *
 * This is the destructive bundle, so the interesting assertions are
 * the refusals. A disk with a filesystem on it, a RAID member, a
 * mounted volume, somebody else's physical volume: each has to be
 * recognised and left, and naming one in a configuration must not make
 * it eligible — narrowing what is considered is not the same as
 * granting permission.
 *
 * Nothing runs. The lsblk, pvs and vgs output is fed in as text.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import CloudConfig from "../util/CloudConfig.ts";
import {
  DiskState,
  OWNER_TAG,
  StorageClass,
  classTag,
  classifyDisk,
  formatSize,
  getVolumeGroups,
  groupServingDisks,
  groupUsableDisks,
  readClassTag,
  readDisks,
} from "../cli/commands/LVM.ts";
import { configFrom } from "./helpers.ts";

const GB = 1024 ** 3;

// The LVM tag character set, from lvm(8)
const LVM_TAG = /^[A-Za-z0-9][A-Za-z0-9_+.\-]*$/;

/**
 * A configuration with one node in it.
 */
function makeConfig(raw: Record<string, unknown> = {}): CloudConfig {
  return configFrom({
    k3s: {},
    nodes: [{ name: "n", address: "n", type: "server" }],
    ...raw,
  });
}

/**
 * One line of "lsblk -P" output.
 */
function device(fields: Record<string, string>): string {
  const base: Record<string, string> = {
    NAME: fields["KNAME"]!,
    KNAME: fields["KNAME"]!,
    TYPE: "disk",
    SIZE: String(500 * GB),
    ROTA: "0",
    TRAN: "sata",
    MODEL: "",
    RO: "0",
    RM: "0",
    MOUNTPOINT: "",
    FSTYPE: "",
    PKNAME: "",
  };

  return Object.entries({ ...base, ...fields })
    .map(([key, value]) => `${key}="${value}"`)
    .join(" ");
}

// A machine that looks like a real server: a partitioned boot disk, an
// LVM member, a RAID member, a mounted disk, a USB stick, a disk too
// small to bother with, a read-only device, swap, an encrypted volume
// — and three genuinely blank disks
const DEVICES = [
  device({ KNAME: "sda", TRAN: "sata", ROTA: "1", MODEL: "BOOT DISK" }),
  device({ KNAME: "sda1", TYPE: "part", PKNAME: "sda", FSTYPE: "vfat", MOUNTPOINT: "/boot/efi", SIZE: String(GB) }),
  device({ KNAME: "sda2", TYPE: "part", PKNAME: "sda", FSTYPE: "ext4", MOUNTPOINT: "/", SIZE: String(400 * GB) }),
  device({ KNAME: "sdb", FSTYPE: "LVM2_member", MODEL: "EXISTING LVM" }),
  device({ KNAME: "sdc", FSTYPE: "linux_raid_member", MODEL: "RAID MEMBER" }),
  device({ KNAME: "sdd", MOUNTPOINT: "/mnt/data", FSTYPE: "xfs", MODEL: "MOUNTED" }),
  device({ KNAME: "sde", RM: "1", TRAN: "usb", MODEL: "USB STICK" }),
  device({ KNAME: "sdf", SIZE: String(GB / 2), MODEL: "TINY" }),
  device({ KNAME: "sdg", RO: "1", MODEL: "READ ONLY" }),
  device({ KNAME: "sdh", FSTYPE: "swap", MODEL: "SWAP" }),
  device({ KNAME: "sdi", FSTYPE: "crypto_LUKS", MODEL: "ENCRYPTED" }),
  device({ KNAME: "nvme0n1", TRAN: "nvme", MODEL: "Samsung 990 PRO", SIZE: String(2048 * GB) }),
  device({ KNAME: "sdj", TRAN: "sata", ROTA: "0", MODEL: "Crucial MX500", SIZE: String(1000 * GB) }),
  device({ KNAME: "sdk", TRAN: "sata", ROTA: "1", MODEL: "WD Red", SIZE: String(8000 * GB) }),
];

/**
 * The command output the disk reader parses.
 *
 * @param lines the device lines
 * @param pvs physical volume lines, as "path|group|tags"
 * @param vgs volume group lines, as "name|tags"
 */
function commandOutput(lines: string[] = DEVICES, pvs: string[] = [], vgs: string[] = []) {
  const text = [
    "== devices ==",
    ...lines,
    "== pvs ==",
    ...pvs,
    "== vgs ==",
    ...vgs,
    "== holders ==",
  ].join("\n");

  return { stdout: text, stderr: "", parsed: text } as any;
}

/**
 * Mark devices as holding LVM, the way they would look in reality.
 *
 * Takes every name at once: the device list has to stay one line per
 * device, and marking them one at a time and merging gives you two
 * copies of each, one marked and one not.
 */
function asPhysicalVolumes(...names: string[]): string[] {
  return DEVICES.map((line) =>
    names.some((name) => line.startsWith(`NAME="${name}"`))
      ? line.replace('FSTYPE=""', 'FSTYPE="LVM2_member"')
      : line,
  );
}

describe("which disks are eligible", () => {
  const disks = readDisks(commandOutput(), makeConfig(), { node: {} });
  const usable = groupUsableDisks(disks);

  it("takes only the genuinely blank ones", () => {
    const names = Object.values(usable).flat().map((disk) => disk.name).sort();

    assert.deepEqual(names, ["nvme0n1", "sdj", "sdk"]);
  });

  const refusals: [string, string][] = [
    ["sda", "partitioned"],
    ["sdb", "physical volume"],
    ["sdc", "RAID"],
    ["sdd", "mounted"],
    ["sde", "removable"],
    ["sdf", "only"],
    ["sdg", "read-only"],
    ["sdh", "swap"],
    ["sdi", "encrypted"],
  ];

  for (const [name, reason] of refusals) {
    it(`refuses ${name}, and says why`, () => {
      const why = disks.find((disk) => disk.name === name)?.unusableBecause ?? "ALLOWED";

      assert.ok(why.includes(reason), why);
    });
  }

  it("never treats the root partition as a candidate of its own", () => {
    assert.ok(disks.every((disk) => disk.name !== "sda2"));
  });
});

describe("what class a disk lands in", () => {
  const usable = groupUsableDisks(readDisks(commandOutput(), makeConfig(), { node: {} }));

  it("puts NVMe in the fast class", () => {
    assert.equal(usable[StorageClass.Ssd]?.[0]?.name, "nvme0n1");
  });

  it("puts a SATA SSD in ssd-sata", () => {
    assert.equal(usable[StorageClass.SsdSata]?.[0]?.name, "sdj");
  });

  it("puts a spinning disk in hdd", () => {
    assert.equal(usable[StorageClass.Hdd]?.[0]?.name, "sdk");
  });

  it("puts a virtual disk with the SATA SSDs", () => {
    assert.equal(
      classifyDisk({ rotational: false, transport: "", kname: "vda" } as any),
      StorageClass.SsdSata,
    );
  });

  it("calls anything rotating hdd, whatever the transport says", () => {
    assert.equal(
      classifyDisk({ rotational: true, transport: "nvme", kname: "x" } as any),
      StorageClass.Hdd,
    );
  });

  it("lets a configuration move a disk to another class", () => {
    const moved = readDisks(
      commandOutput(),
      makeConfig({ storage: { diskClasses: { "/dev/sdk": "ssd" } } }),
      { node: {} },
    );

    assert.ok(
      groupUsableDisks(moved)[StorageClass.Ssd]?.some((disk) => disk.name === "sdk"),
    );
  });
});

describe("naming disks in a configuration", () => {
  it("narrows the set to the ones named", () => {
    const named = readDisks(
      commandOutput(),
      makeConfig({ storage: { disks: ["/dev/nvme0n1"] } }),
      { node: {} },
    );

    assert.deepEqual(
      Object.values(groupUsableDisks(named)).flat().map((disk) => disk.name),
      ["nvme0n1"],
    );
  });

  it("does not make a disk that's in use eligible", () => {
    // This says which disks to consider, not which to wipe
    const dangerous = readDisks(
      commandOutput(),
      makeConfig({ storage: { disks: ["/dev/sda", "/dev/sdb"] } }),
      { node: {} },
    );

    assert.equal(Object.values(groupUsableDisks(dangerous)).flat().length, 0);
  });

  it("reports one the node doesn't have", () => {
    const missing = readDisks(
      commandOutput(),
      makeConfig({ storage: { disks: ["/dev/sdzz"] } }),
      { node: {} },
    );

    assert.ok(
      missing.some(
        (disk) => disk.name === "sdzz" && disk.unusableBecause?.includes("doesn't have it"),
      ),
    );
  });

  it("lets a node's own settings beat the cluster-wide ones", () => {
    const perNode = readDisks(
      commandOutput(),
      makeConfig({ storage: { disks: ["/dev/sdj"] } }),
      { node: { storage: { disks: ["/dev/sdk"] } } },
    );

    assert.deepEqual(
      Object.values(groupUsableDisks(perNode)).flat().map((disk) => disk.name),
      ["sdk"],
    );
  });
});

describe("ownership by tag rather than by name", () => {
  // Two disks are already physical volumes in groups whose names look
  // exactly like ours. One carries our tag and one doesn't.
  const output = commandOutput(
    asPhysicalVolumes("nvme0n1", "sdj"),
    [
      `/dev/nvme0n1|cc-ssd-vg|${OWNER_TAG},${classTag("ssd")}`,
      "/dev/sdj|cc-ssd-sata-vg|",
    ],
    [`cc-ssd-vg|${OWNER_TAG},${classTag("ssd")}`, "cc-ssd-sata-vg|"],
  );

  const disks = readDisks(output, makeConfig(), { node: {} });
  const ours = disks.find((disk) => disk.name === "nvme0n1");
  const theirs = disks.find((disk) => disk.name === "sdj");

  it("recognises a physical volume we tagged", () => {
    assert.equal(ours?.state, DiskState.Claimed);
    assert.equal(ours?.volumeGroup, "cc-ssd-vg");
  });

  it("does not claim an untagged one in a group with our name", () => {
    assert.equal(theirs?.state, DiskState.Unusable);
  });

  it("leaves it alone with a reason", () => {
    assert.ok(theirs?.unusableBecause?.includes("physical volume"));
  });

  it("still counts a claimed disk as serving its class", () => {
    assert.ok(
      groupServingDisks(disks)[StorageClass.Ssd]?.some((disk) => disk.name === "nvme0n1"),
    );
  });

  it("but doesn't offer it up to be wiped again", () => {
    assert.ok(
      !groupUsableDisks(disks)[StorageClass.Ssd]?.some((disk) => disk.name === "nvme0n1"),
    );
  });

  it("lets the class tag beat what the hardware suggests", () => {
    const tagged = readDisks(
      commandOutput(
        asPhysicalVolumes("sdk"),
        [`/dev/sdk|cc-ssd-vg|${OWNER_TAG},${classTag("ssd")}`],
        [`cc-ssd-vg|${OWNER_TAG}`],
      ),
      makeConfig(),
      { node: {} },
    );

    assert.equal(
      tagged.find((disk) => disk.name === "sdk")?.storageClass,
      StorageClass.Ssd,
      "a spinning disk set up as ssd keeps that class",
    );
  });
});

describe("the tags themselves", () => {
  it("reads a class back from its tag", () => {
    assert.equal(readClassTag([OWNER_TAG, classTag("ssd-sata")]), StorageClass.SsdSata);
  });

  it("reads a class we don't know as nothing", () => {
    assert.equal(readClassTag([OWNER_TAG, "cc-class-banana"]), undefined);
  });

  it("are valid LVM tags", () => {
    for (const tag of [OWNER_TAG, ...Object.values(StorageClass).map(classTag)]) {
      assert.match(tag, LVM_TAG);
    }
  });
});

describe("the volume groups to create", () => {
  it("come from the TopoLVM values rather than from here", () => {
    assert.deepEqual(getVolumeGroups(makeConfig()), {
      ssd: "cc-ssd-vg",
      "ssd-sata": "cc-ssd-sata-vg",
      "ssd-cache": "cc-ssd-cache-vg",
      hdd: "cc-hdd-vg",
    });
  });
});

describe("sizes", () => {
  it("read as sizes", () => {
    assert.equal(formatSize(8000 * GB), "7.8TB");
  });
});
