param([int]$ParentProcessId)
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class AdvisorAwake {
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern uint SetThreadExecutionState(uint flags);
}
'@
try {
  if ([AdvisorAwake]::SetThreadExecutionState([uint32]2147483651) -eq 0) { throw 'SetThreadExecutionState failed' }
  Write-Output 'Windows keep-awake active'
  while (Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue) {
    [void][AdvisorAwake]::SetThreadExecutionState([uint32]2147483651)
    Start-Sleep -Seconds 15
  }
} finally { [void][AdvisorAwake]::SetThreadExecutionState([uint32]2147483648) }
