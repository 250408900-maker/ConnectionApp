import { useWindowDimensions } from "react-native";

/** Treat tablets and desktop web as a wide layout. */
export function useWideLayout() {
  const { width } = useWindowDimensions();
  const wide = width >= 768;
  const maxContentWidth = wide ? 960 : undefined;
  return { width, wide, maxContentWidth };
}
