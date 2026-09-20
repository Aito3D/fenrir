; Fenrir Windows Installer — Inno Setup script
;
; Builds a self-contained installer that lays down:
;   - embedded Python 3.13 + pre-installed venv
;   - backend source + pre-built frontend bundle
;   - NSSM + ffmpeg under bin/
;   - a Windows service running as LocalSystem
;
; Build prerequisites: run installers/windows/build.py first to stage
; the build/staging/ tree, then compile this file with ISCC.exe.
;
; See installers/windows/README.md for the full pipeline.

#define MyAppName "Fenrir"
#define MyAppPublisher "Martin Ziegler"
#define MyAppURL "https://bambuddy.cool"
#define MyAppExeName "fenrir.exe"
#define ServiceName "Fenrir"
#define DefaultPort "8000"

; Version is stamped by build.py into build\staging\version.iss as a
; #define directive. Falls back to a placeholder if you ran ISCC without
; running build.py first (don't ship that build).
#ifexist "build\staging\version.iss"
  #include "build\staging\version.iss"
#else
  #define MyAppVersion "0.0.0+dev"
#endif

[Setup]
AppId={{8C9C9E1A-7C5A-4F2A-9F1B-FENRIR00001}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\Fenrir
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
LicenseFile=..\..\LICENSE
OutputDir=build\output
OutputBaseFilename=fenrir-{#MyAppVersion}-windows-x64-setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; Admin required: we register a Windows service and write to ProgramData
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=
; Fenrir branding — bambuddy.ico is a multi-resolution .ico (16/32/48/
; 64/128/256) generated from frontend/public/img/favicon.png; lives next
; to this .iss so the SourcePath-relative reference works during compile
; and the [Files] entry stages it into {app} for Add/Remove Programs.
SetupIconFile=bambuddy.ico
UninstallDisplayIcon={app}\bambuddy.ico
; Don't allow installing to a network drive — service won't start cleanly
DisableDirPage=no
DisableReadyPage=no
ChangesEnvironment=no
CloseApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional shortcuts:"; Flags: unchecked
Name: "firewallrule"; Description: "Add Windows Firewall rule for Fenrir (port {#DefaultPort})"; GroupDescription: "Network:"

[Files]
; Embedded Python (entire tree)
Source: "build\staging\python\*"; DestDir: "{app}\python"; Flags: recursesubdirs ignoreversion
; Backend + frontend
Source: "build\staging\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion
; NSSM, ffmpeg, ffprobe
Source: "build\staging\bin\*"; DestDir: "{app}\bin"; Flags: recursesubdirs ignoreversion
; Service install/uninstall scripts
Source: "build\staging\service\*"; DestDir: "{app}\service"; Flags: recursesubdirs ignoreversion
; Version stamp
Source: "build\staging\VERSION"; DestDir: "{app}"; Flags: ignoreversion
; App icon — used by UninstallDisplayIcon (Add/Remove Programs) and the
; Start Menu / desktop shortcuts. Lives at the install root so the
; UninstallDisplayIcon path stays stable when the [Files] tree changes.
Source: "bambuddy.ico"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; ProgramData layout — created with permissions LocalSystem can write to
Name: "{commonappdata}\Fenrir"; Permissions: users-modify
Name: "{commonappdata}\Fenrir\data"; Permissions: users-modify
Name: "{commonappdata}\Fenrir\logs"; Permissions: users-modify

[Icons]
Name: "{group}\Open Fenrir Dashboard"; Filename: "http://localhost:{#DefaultPort}"; IconFilename: "{app}\bambuddy.ico"
Name: "{group}\Fenrir Logs"; Filename: "{commonappdata}\Fenrir\logs"
Name: "{group}\Uninstall Fenrir"; Filename: "{uninstallexe}"
Name: "{commondesktop}\Fenrir"; Filename: "http://localhost:{#DefaultPort}"; IconFilename: "{app}\bambuddy.ico"; Tasks: desktopicon

[Run]
; Register and start the Windows service
Filename: "{app}\service\install-service.bat"; Parameters: """{app}"" ""{commonappdata}\Fenrir"" {#DefaultPort}"; Flags: runhidden waituntilterminated; StatusMsg: "Registering Fenrir service..."

; Open Windows Firewall on the dashboard port. We do this only if the
; user opted in via the firewallrule task — some environments manage
; firewall centrally and prefer to handle this themselves.
Filename: "netsh.exe"; Parameters: "advfirewall firewall add rule name=""Fenrir Dashboard"" dir=in action=allow protocol=TCP localport={#DefaultPort}"; Flags: runhidden waituntilterminated; Tasks: firewallrule; StatusMsg: "Adding firewall rule..."

; Open the dashboard in the user's default browser at the end of install
Filename: "http://localhost:{#DefaultPort}"; Flags: shellexec postinstall nowait skipifsilent; Description: "Open Fenrir Dashboard"

[UninstallRun]
; Stop + deregister the service before file removal. RunOnceId makes the
; entry run-once per uninstall pass (Inno Setup default is to re-run on
; every pass, which can fire multiple times during upgrade flows).
Filename: "{app}\service\uninstall-service.bat"; Parameters: """{app}"""; Flags: runhidden waituntilterminated; RunOnceId: "StopFenrirService"

; Remove the firewall rule (silently — if it doesn't exist, netsh just complains)
Filename: "netsh.exe"; Parameters: "advfirewall firewall delete rule name=""Fenrir Dashboard"""; Flags: runhidden waituntilterminated; RunOnceId: "RemoveFirewallRule"

[UninstallDelete]
; Remove install dir contents; leave ProgramData\Fenrir alone so the
; user keeps their database + archives. Re-installing on top picks them
; back up automatically.
Type: filesandordirs; Name: "{app}"

[Code]

// Stop the Fenrir service BEFORE the [Files] section copies anything,
// so file locks on python.exe / .pyd / nssm.exe release in time for the
// overwrite. Without this, upgrading over a running install fails with
// "permission denied" on every file the service has open.
//
// On a fresh install {app}\bin\nssm.exe doesn't exist yet — FileExists
// guards that path so the hook is a no-op for first-time installers.
// The Sleep gives Windows a beat to finalize the python.exe unload
// before the [Files] step starts grabbing exclusive handles.
//
// The install-service.bat in [Run] does `nssm remove ... confirm` plus
// a fresh `nssm install`, so even if we leave the old service entry in
// place here, the post-install step re-registers it cleanly.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  NssmPath: string;
begin
  Result := '';
  NeedsRestart := False;

  NssmPath := ExpandConstant('{app}\bin\nssm.exe');
  if FileExists(NssmPath) then
  begin
    Log('Stopping Fenrir service before file copy...');
    Exec(NssmPath, 'stop Fenrir', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    // ResultCode 0 == stopped; non-zero is fine too (already stopped /
    // service not registered). The lock we care about is python.exe's,
    // and it's released the moment the process exits.
    Sleep(1500);
  end;
end;

// Pre-install check: refuse to install if port 8000 is already in use by
// something other than a previous Fenrir install. This catches the
// "I have something else on 8000" case early instead of after install.
function InitializeSetup(): Boolean;
begin
  Result := True;
  // TODO: optional port-conflict check. Inno Setup doesn't have a
  // native socket API; would need a tiny helper exe or a netstat parse.
  // Defer to v1.1 — for v1, accept that conflicts surface at first
  // service start and the user reads the log.
end;
