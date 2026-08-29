import { Tabs } from 'expo-router';
import React from 'react';

import { HapticTab } from '@/components/haptic-tab';
import { IconSymbol } from '@/components/ui/icon-symbol';
import { DashboardColors } from '@/constants/dashboard-theme';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarButton: HapticTab,
        tabBarActiveTintColor: DashboardColors.accent,
        tabBarInactiveTintColor: DashboardColors.textFaint,
        tabBarStyle: {
          backgroundColor: DashboardColors.bgElevated,
          borderTopColor: DashboardColors.border,
        },
      }}
    >
      <Tabs.Screen
        name="dashboard"
        options={{
          title: 'Dashboard',
          tabBarIcon: ({ color }) => (
            <IconSymbol
              size={26}
              name="chart.bar.fill"
              color={color}
            />
          ),
        }}
      />

      <Tabs.Screen
        name="index"
        options={{
          title: 'Connect',
          tabBarIcon: ({ color }) => (
            <IconSymbol
              size={26}
              name="link"
              color={color}
            />
          ),
        }}
      />
    </Tabs>
  );
}