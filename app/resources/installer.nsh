; Tender's additions to the Windows installer (electron-builder picks this file up
; from the build resources folder).
;
; If Docker Desktop is installed, one extra page offers to help move the user's
; containers out of it. Ticked, it leaves a marker file; on its first start
; Tender sees the marker, deletes it and opens the move page. The installer
; itself never touches Docker Desktop or Docker's data.

!include nsDialogs.nsh
!include LogicLib.nsh

!ifndef BUILD_UNINSTALLER

Var TenderMigrateBox
Var TenderMigrate

!macro customPageAfterChangeDir
  Page custom TenderMigratePageShow TenderMigratePageLeave
!macroend

Function TenderMigratePageShow
  StrCpy $TenderMigrate "0"
  ${IfNot} ${FileExists} "$PROGRAMFILES64\Docker\Docker\Docker Desktop.exe"
    Abort ; no Docker Desktop: skip the page
  ${EndIf}
  ; What MUI_HEADER_TEXT does; that macro is not defined yet where this file is included.
  GetDlgItem $1 $HWNDPARENT 1037
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Docker Desktop found"
  GetDlgItem $1 $HWNDPARENT 1038
  SendMessage $1 ${WM_SETTEXT} 0 "STR:Tender can bring your containers over."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateLabel} 0 0 100% 64u "Docker Desktop is installed on this computer, and your containers, images and volumes live inside it.$\r$\n$\r$\nWhen Tender opens, it can copy them into the Docker Engine inside WSL, so you can stop using Docker Desktop. You choose what to move, and nothing is deleted from Docker Desktop."
  Pop $0
  ${NSD_CreateCheckbox} 0 76u 100% 12u "Help me move my containers when Tender opens"
  Pop $TenderMigrateBox
  ${NSD_Check} $TenderMigrateBox
  nsDialogs::Show
FunctionEnd

Function TenderMigratePageLeave
  ${NSD_GetState} $TenderMigrateBox $TenderMigrate
FunctionEnd

!macro customInstall
  ${If} $TenderMigrate == ${BST_CHECKED}
    CreateDirectory "$APPDATA\${PRODUCT_NAME}"
    FileOpen $0 "$APPDATA\${PRODUCT_NAME}\offer-migration" w
    FileClose $0
  ${EndIf}
!macroend

!endif
