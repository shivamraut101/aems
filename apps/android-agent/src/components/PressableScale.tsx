import { useCallback } from "react";
import { Pressable, type GestureResponderEvent, type PressableProps } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface PressableScaleProps extends PressableProps {
  /** How far the control shrinks on press. Smaller controls read better with a smaller number. */
  scaleTo?: number;
}

/**
 * The tactile press-and-release feel iOS controls have — a quick spring scale
 * down on touch, not the flat opacity change `Pressable` gives you on its own.
 * Shared by every button/row in this app rather than reimplemented per screen.
 */
export function PressableScale({ scaleTo = 0.97, onPressIn, onPressOut, style, ...props }: PressableScaleProps) {
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      scale.value = withSpring(scaleTo, { damping: 18, stiffness: 420 });
      onPressIn?.(event);
    },
    [onPressIn, scale, scaleTo],
  );

  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      scale.value = withSpring(1, { damping: 15, stiffness: 300 });
      onPressOut?.(event);
    },
    [onPressOut, scale],
  );

  return (
    <AnimatedPressable
      {...props}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      style={[style, animatedStyle]}
    />
  );
}
