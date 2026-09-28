/**
 * Page renderers — every page is built server-side from the database.
 * Single source of truth: nothing is rendered that isn't in the DB.
 *
 * Facade: the renderers live in ./pages/<group>.ts and are re-exported
 * here unchanged.
 */
export { capFirst } from "./pages/shared";
export { loginPage, resetPasswordPage, setupPage } from "./pages/auth";
export { kindLabel, dashboardPage } from "./pages/dashboard";
export { admissionsPage } from "./pages/admissions";
export { applicantsPage } from "./pages/applicants";
export { terminologyFor, stageLabelFor, casePage, composePage, composeWindowPage } from "./pages/case";
export { mailPage, mailThreadPage } from "./pages/mail";
export { settingsPage, connectionsSection, accountPage } from "./pages/settings";
export { ruleTreeText, configPage } from "./pages/config";
export { templatesPage } from "./pages/templates";
export { staffPage } from "./pages/staff";
export { replayPage, sampleFactsFromRules, intakeTestPage } from "./pages/diagnostics";
