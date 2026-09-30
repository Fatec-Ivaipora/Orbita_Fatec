' Inicia o agente da Cobrança (Edubox -> Órbita) sem abrir janela e o
' reinicia se ele parar. Um atalho para este arquivo fica na pasta
' "Inicializar" do Windows (shell:startup), pra subir junto com o PC.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
pasta = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = fso.GetParentFolderName(pasta)
Do
    sh.Run "node """ & pasta & "\cobranca-edubox-agente.js""", 0, True
    WScript.Sleep 60000
Loop
