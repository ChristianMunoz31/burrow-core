; Burrow keeps the user's data in $APPDATA\Burrow. The Tauri app-data folder uses a different name
; (com.burrow.desktop), so neither the installer nor the uninstaller ever touches the Burrow data.

!macro NSIS_HOOK_PREINSTALL
  StrCmp $INSTDIR "$APPDATA\Burrow" 0 +3
    MessageBox MB_OK|MB_ICONSTOP "Burrow cannot be installed into $APPDATA\Burrow, because that folder holds your Burrow data. Choose another folder." /SD IDOK
    Abort
  DetailPrint "Your Burrow data in $APPDATA\Burrow is kept on update and uninstall."
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    MessageBox MB_OK|MB_ICONINFORMATION "Your Burrow data in $APPDATA\Burrow was kept." /SD IDOK
  ${EndIf}
!macroend
