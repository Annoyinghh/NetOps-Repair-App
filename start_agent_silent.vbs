Set WshShell = CreateObject("WScript.Shell")
agentPath = WshShell.ExpandEnvironmentStrings("%USERPROFILE%") & "\Desktop\NetOpsAgent.exe"
WshShell.Run """" & agentPath & """", 0, False
