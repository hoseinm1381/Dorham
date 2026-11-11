Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Dorham migration test"
OutFile "$%DORHAM_TEST_MIGRATION_RUNNER%"

!include LogicLib.nsh
!define BUILD_RESOURCES_DIR "$%DORHAM_TEST_MIGRATION_RESOURCES%"
!include "${BUILD_RESOURCES_DIR}\migration.nsh"

Section
  ReadEnvStr $INSTDIR DORHAM_TEST_MIGRATION_INSTALL
  ReadEnvStr $R2 DORHAM_TEST_MIGRATION_ROAMING
  ReadEnvStr $R3 DORHAM_TEST_MIGRATION_DESTINATION
  !insertmacro exportPreviousProfile "$R2" "$R3"
SectionEnd
