Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\sk621\scraper"
WshShell.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\sk621\scraper\daemon.js""", 0, False
