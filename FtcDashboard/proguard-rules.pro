# Keep HardwareConfig and related classes from DashboardCore
-keep class com.acmerobotics.dashboard.HardwareConfig { *; }

# Keep all message classes that reference HardwareConfig
-keep class com.acmerobotics.dashboard.message.redux.** { *; }

# Keep all dashboard message types
-keep class com.acmerobotics.dashboard.message.** { *; }

# Keep dashboard config classes
-keep class com.acmerobotics.dashboard.config.** { *; }

# Keep OpModeInfo
-keep class com.acmerobotics.dashboard.OpModeInfo { *; }
