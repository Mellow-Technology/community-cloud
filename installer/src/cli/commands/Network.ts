import Command, { OutputType } from "./Command.ts";

/**
 * Network interface information
 * as it comes from the "ip" command
 */
interface NetworkIface {
  ifindex: number;
  ifname: string;
  flags: string[];
  mtu: number;
  qdisc: string;
  operstate: string;
  group: string;
  txqlen: number;
  link_type: string;
  address: string;
  broadcast: string;
  addr_info: IPAddressInfo[];
}

/**
 * IP address info as it comes
 * from the "ip" command
 */
interface IPAddressInfo {
  family: string;
  local: string;
  prefixlen: number;
  broadcast: string;
  scope: string;
  valid_life_time: number;
  preferred_life_time: number;

  // Various flags
  "stable-privacy"?: boolean;
  temporary?: boolean;
  dynamic?: boolean;
  mngtmpaddr?: boolean;
  noprefixroute?: boolean;
}

class NetworkInfo extends Command {
  ROUTABLE_REGEX = /(enp|wlp|tailscale).*/;

  constructor() {
    super("ip -j a", OutputType.Json);
    this.postProcessHooks.push(this.getCandidateIPs);
  }

  getCandidateIPs(interfaces: NetworkIface[]) {
    // Filter interfaces so that we're generally grabbing
    // ethernet, wireless, or tailscale (VPN) interfaces
    const routableInterfaces: NetworkIface[] = interfaces.filter((iface) => {
      return this.ROUTABLE_REGEX.test(iface.ifname);
    });

    // Get a list of IPs
    const interfaceIPs = {};
    for (let i = 0; i < routableInterfaces.length; i++) {
      const { ifname, addr_info } = routableInterfaces[i];

      // If there are no configured IP addresses
      // on the interface then skip it
      if (addr_info.length > 0) {
        interfaceIPs[ifname] = addr_info;
      }
    }

    return interfaceIPs;
  }
}
