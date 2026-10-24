param([int]$ProcessId)
# On battery, Windows 11 power-throttles windowless background processes (EcoQoS: efficiency cores, low clocks). Measured
# 2026-10-23 on a Core Ultra 7 155H: the engine ran the same code 3.5-7x slower than a foreground process and fell
# seconds behind Kalshi in busy minutes. Opting out (ControlMask EXECUTION_SPEED, StateMask 0) restored full speed.
# Per process, no admin, gone when the process exits. Prints the resulting mask so the caller can check it took.
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AdvisorSpeed {
 [StructLayout(LayoutKind.Sequential)] public struct Throttling { public uint Version; public uint ControlMask; public uint StateMask; }
 [DllImport("kernel32.dll", SetLastError=true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetProcessInformation(IntPtr process, int infoClass, ref Throttling info, int size);
 [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetProcessInformation(IntPtr process, int infoClass, ref Throttling info, int size);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
# PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION; ProcessPowerThrottling = 4.
$handle = [AdvisorSpeed]::OpenProcess(0x1200, $false, $ProcessId)
if ($handle -eq [IntPtr]::Zero) { throw "OpenProcess failed ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
try {
  $state = New-Object AdvisorSpeed+Throttling
  $state.Version = 1; $state.ControlMask = 1; $state.StateMask = 0
  $size = [Runtime.InteropServices.Marshal]::SizeOf($state)
  if (-not [AdvisorSpeed]::SetProcessInformation($handle, 4, [ref]$state, $size)) { throw "SetProcessInformation failed ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  $check = New-Object AdvisorSpeed+Throttling
  $check.Version = 1
  if (-not [AdvisorSpeed]::GetProcessInformation($handle, 4, [ref]$check, $size)) { throw "GetProcessInformation failed ($([Runtime.InteropServices.Marshal]::GetLastWin32Error()))" }
  Write-Output "ControlMask=$($check.ControlMask) StateMask=$($check.StateMask)"
} finally { [void][AdvisorSpeed]::CloseHandle($handle) }
