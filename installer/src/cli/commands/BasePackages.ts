/**
 * @file
 * Install base packages needed for everything to run.
 *
 * Every apt call here retries while the package lock is held by
 * something else, and that is not defensive padding. A machine that
 * was provisioned a minute ago is running unattended-upgrades and the
 * apt-daily timer, both of which hold a lock, and "provision some
 * machines and then install onto them" is the ordinary way anybody
 * uses this. Without the retry the very first step of the very first
 * bundle fails on a brand new node — the worst possible moment to hand
 * somebody an error about a lock file.
 *
 * The retry is written out rather than left to apt's own
 * DPkg::Lock::Timeout because that option covers the dpkg lock and the
 * failure seen in practice is on the lists lock, which "apt-get
 * update" takes and the option did not wait for. The option is set as
 * well, since it does help the install half.
 *
 * Only a lock is retried. Anything else — no network, no such package,
 * a mirror returning nonsense — fails at once, because retrying it
 * would turn a clear error into a slow one.
 *
 * TODO: Support more than just Ubuntu.
 */
import { OutputType } from "./Command.ts";

// How long to keep trying while something else holds the lock. Long
// enough to outlast a first-boot upgrade, short enough that a lock
// nothing will release fails the step rather than hanging the install.
export const APT_LOCK_ATTEMPTS = 60;
export const APT_LOCK_WAIT_SECONDS = 5;

// Passed as well, for the dpkg lock during an install
export const APT_LOCK_TIMEOUT_SECONDS = APT_LOCK_ATTEMPTS * APT_LOCK_WAIT_SECONDS;

// What apt says when it's waiting on somebody else rather than
// genuinely failing
const LOCK_MESSAGES = ["Could not get lock", "Unable to acquire the dpkg frontend lock"];

/**
 * An apt command that waits its turn.
 *
 * Written as lines, which is how every other command in here is built,
 * so it joins into a script the same way.
 *
 * @param args what to ask apt-get to do
 * @param what to say when it genuinely fails
 * @returns the lines of shell
 */
export function apt(args: string, what: string): string[] {
  const command = `sudo DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=${APT_LOCK_TIMEOUT_SECONDS} ${args}`;

  return [
    "attempt=0",
    "while :",
    "do",
    `  output=$(${command} 2>&1) && break`,
    "  case \"$output\" in",
    `    ${LOCK_MESSAGES.map((message) => `*"${message}"*`).join("|")})`,
    "      attempt=$((attempt + 1))",
    `      if [ "$attempt" -ge ${APT_LOCK_ATTEMPTS} ]`,
    "      then",
    `        echo "$output" >&2`,
    `        echo "${what}: apt is still locked by something else after ${APT_LOCK_TIMEOUT_SECONDS}s. A newly provisioned machine runs unattended-upgrades on first boot; give it a minute and try again." >&2`,
    "        exit 1",
    "      fi",
    `      sleep ${APT_LOCK_WAIT_SECONDS}`,
    "      ;;",
    "    *)",
    `      echo "$output" >&2`,
    `      echo "${what}" >&2`,
    "      exit 1",
    "      ;;",
    "  esac",
    "done",
    'printf "%s\\n" "$output"',
  ];
}

export const BasePackageCommands = [
  {
    name: "update-apt",
    description: "Update the package index",
    command: apt("update -q", "Couldn't update the package index"),
    output: OutputType.Raw,
  },
  {
    name: "install-jc",
    description: "Install 'jc', which turns command output into JSON",
    command: apt("install -y jc", "Couldn't install jc"),
    output: OutputType.Raw,
  },
];
