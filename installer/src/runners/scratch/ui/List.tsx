import { Text, Box, Newline } from "ink";

export enum ListType {
  Ordered = "ordered",
  Unordered = "unordered",
}

export default function List({
  items,
  type = ListType.Unordered,
  emptyMessage = "No items to show",
}: {
  items: string[];
  type: ListType;
  emptyMessage: string;
}) {
  let itemList = null;
  if (items.length > 0) {
    itemList = items.map((item, i) => {
      // Format the list item based
      // on whether it's unordered or not
      let displayItem = null;
      if (type == ListType.Unordered) {
        displayItem = item;
      } else {
        displayItem = `${i + 1}. ${item}`;
      }

      return (
        <Text>
          {displayItem}
          <Newline />
        </Text>
      );
    });
  } else {
    itemList = <Text>{emptyMessage}</Text>;
  }

  return (
    <Box padding={2} borderStyle="single">
      {itemList}
    </Box>
  );
}
