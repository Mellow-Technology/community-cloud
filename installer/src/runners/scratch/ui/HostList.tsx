import Config from "../../util/CloudConfig.ts";
import List, { ListType } from "./List.tsx";
import { useState, useEffect } from "react";

export default function HostList() {
  const [items, setItems] = useState([]);

  useEffect(() => {
    (async () => {
      const hosts = await getAvailableHosts();
      setItems(hosts.map((host) => host.name));
    })();
  });

  return (
    <List items={items} type={ListType.Ordered} emptyMessage="No hosts found" />
  );
}
