; Sherit Mail's per-user registrations (written by the app on every launch, src/win.rs register/set_login_item) leave with it.
; Not on an update: the updater reinstalls over the top with /UPDATE and the app writes them again when it restarts.
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegKey HKCU "Software\Classes\sheritmail"
    DeleteRegKey HKCU "Software\Classes\SheritMail.mailto"
    DeleteRegKey HKCU "Software\Clients\Mail\Sherit Mail"
    DeleteRegValue HKCU "Software\RegisteredApplications" "Sherit Mail"
    DeleteRegKey HKCU "Software\Classes\AppUserModelId\com.sheritlabs.mail"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Sherit Mail"
  ${EndIf}
!macroend
