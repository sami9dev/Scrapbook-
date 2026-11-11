Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\sk621\scraper"
WshShell.Run "cmd /c ""node C:\Users\sk621\scraper\daemon.js""", 0, False
