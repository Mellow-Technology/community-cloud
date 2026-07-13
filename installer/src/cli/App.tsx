import { Box, Newline, Text } from "ink";
import BigText from "ink-big-text";
import HostList from "./components/HostList.tsx";

export default function App() {
  return (
    <>
      <Box marginTop={1}>
        <Text>
          Welcome to...
          <Text color="redBright">
            <BigText text="Community" />
          </Text>
          <Newline />
          <Text color="blueBright">
            <BigText text="Cloud" />
          </Text>
        </Text>
      </Box>

      <Newline />
      <HostList />
    </>
  );
}
