; Burrow Dev installs next to Burrow and keeps its own data in $APPDATA\Burrow Dev. The Tauri app-data
; folder uses a different name (com.burrow.desktop.dev), so neither the installer nor the uninstaller ever
; touches the Burrow Dev data, and nothing here touches Burrow or its data in $APPDATA\Burrow.
;
; Safety net: the install folder must not be, lie inside, or contain a folder that belongs to Burrow or holds
; its data. The folder is normalized first (full path, no trailing backslash, long names), then compared with
; $APPDATA\Burrow, $LOCALAPPDATA\Burrow, the Burrow Dev data folder and the install folder Burrow recorded.
; Burrow (publisher "Burrow", product "Burrow", per-user install) records its folder in
; HKCU "Software\Burrow\Burrow" (default value) and HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Burrow"
; (InstallLocation, quoted); see the NSIS template of Tauri 2.12.1.

Var BdIn
Var BdOut
Var BdInst
Var BdTmp
Var BdLen
Var BdHead
Var BdPre
Var BdHit

; In: $BdIn. Out: $BdOut = the folder without surrounding quotes, as a full path, without a trailing backslash.
Function BurrowDevNormalize
  StrCpy $BdOut $BdIn
  StrCmp $BdIn "" burrow_dev_norm_done
  ; Registry values such as InstallLocation are quoted.
  StrCpy $BdTmp $BdOut 1
  StrCmp $BdTmp "$\"" 0 burrow_dev_norm_unquoted
    StrCpy $BdOut $BdOut "" 1
    StrCpy $BdTmp $BdOut 1 -1
    StrCmp $BdTmp "$\"" 0 burrow_dev_norm_unquoted
      StrCpy $BdOut $BdOut -1
  burrow_dev_norm_unquoted:
  ClearErrors
  GetFullPathName $BdTmp $BdOut
  IfErrors burrow_dev_norm_trim
  StrCmp $BdTmp "" burrow_dev_norm_trim
    StrCpy $BdOut $BdTmp
  burrow_dev_norm_trim:
  StrCpy $BdTmp $BdOut 1 -1
  StrCmp $BdTmp "\" 0 burrow_dev_norm_done
    StrCpy $BdOut $BdOut -1
    Goto burrow_dev_norm_trim
  burrow_dev_norm_done:
FunctionEnd

; In: $BdIn (a folder to protect, may be empty) and $BdInst (the normalized install folder).
; Out: $BdHit = "1" when the install folder equals, lies inside, or contains it. NSIS compares strings
; case-insensitively with StrCmp.
Function BurrowDevCheckCandidate
  StrCpy $BdHit ""
  Call BurrowDevNormalize
  StrCmp $BdOut "" burrow_dev_check_done
  StrCmp $BdInst "" burrow_dev_check_done
  StrCmp $BdInst $BdOut burrow_dev_check_hit
  ; The install folder lies inside the candidate: it starts with "<candidate>\".
  StrLen $BdLen $BdOut
  IntOp $BdLen $BdLen + 1
  StrCpy $BdHead $BdInst $BdLen
  StrCpy $BdPre "$BdOut\"
  StrCmp $BdHead $BdPre burrow_dev_check_hit
  ; The install folder contains the candidate: the candidate starts with "<install folder>\".
  StrLen $BdLen $BdInst
  IntOp $BdLen $BdLen + 1
  StrCpy $BdHead $BdOut $BdLen
  StrCpy $BdPre "$BdInst\"
  StrCmp $BdHead $BdPre burrow_dev_check_hit
  Goto burrow_dev_check_done
  burrow_dev_check_hit:
    StrCpy $BdHit "1"
  burrow_dev_check_done:
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  StrCpy $BdIn "$INSTDIR"
  Call BurrowDevNormalize
  StrCpy $BdInst $BdOut

  StrCpy $BdIn "$APPDATA\Burrow Dev"
  Call BurrowDevCheckCandidate
  StrCmp $BdHit "1" burrow_dev_refuse
  StrCpy $BdIn "$APPDATA\Burrow"
  Call BurrowDevCheckCandidate
  StrCmp $BdHit "1" burrow_dev_refuse
  StrCpy $BdIn "$LOCALAPPDATA\Burrow"
  Call BurrowDevCheckCandidate
  StrCmp $BdHit "1" burrow_dev_refuse
  ReadRegStr $BdIn HKCU "Software\Burrow\Burrow" ""
  Call BurrowDevCheckCandidate
  StrCmp $BdHit "1" burrow_dev_refuse
  ReadRegStr $BdIn HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Burrow" "InstallLocation"
  Call BurrowDevCheckCandidate
  StrCmp $BdHit "1" burrow_dev_refuse
  Goto burrow_dev_allowed
  burrow_dev_refuse:
    MessageBox MB_OK|MB_ICONSTOP "Burrow Dev cannot be installed into $INSTDIR, because that folder belongs to Burrow or holds Burrow data. Choose another folder." /SD IDOK
    Abort
  burrow_dev_allowed:
  DetailPrint "Your Burrow Dev data in $APPDATA\Burrow Dev is kept on update and uninstall. Burrow and its data are not touched."
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    MessageBox MB_OK|MB_ICONINFORMATION "Your Burrow Dev data in $APPDATA\Burrow Dev was kept." /SD IDOK
  ${EndIf}
!macroend
