/**
 * Host command modules, gathered in one place.
 *
 * Every module registers its own slice of the Tauri command surface. They are
 * independent of each other except for the suggestion support that `projects`
 * needs injected, which is why the wiring lives here rather than inside any of
 * them: only the integration layer knows about all three at once.
 */

import { registerAutomationCommands } from "./automations.js";
import { registerCapsuleCommands } from "./capsule.js";
import { registerConversationCommands } from "./conversations.js";
import {
  disposeDictation,
  initDictationHotkey,
  registerDictationCommands,
} from "./dictation.js";
import { registerGatewayCommands } from "./gateway.js";
import { registerProjectCommands, setSuggestionSupport } from "./projects.js";
import { disposeTerminals, registerTerminalCommands } from "./terminal.js";
import { registerWorkspaceCommands } from "./workspace.js";

import { registerSettingsCommands } from "./settings.js";
import { registerSkillsCommands } from "./skills.js";
import { registerTietiezhiCommands } from "./tietiezhi.js";
import { suggestionSupport } from "./suggestions.js";

export { dataDir, importLegacyDataOnce } from "./paths.js";
/** Teardown and startup hooks the integration layer drives. */
export { disposeDictation, disposeTerminals, initDictationHotkey };

/**
 * Registers every ported host command. Must run **after**
 * `importLegacyDataOnce()`: several modules read their store on first call, and
 * a read that lands before the import would cache an empty profile.
 */
export function registerHostModules(): void {
  registerSettingsCommands();
  registerConversationCommands();
  registerProjectCommands();
  registerSkillsCommands();
  registerTietiezhiCommands();
  registerGatewayCommands();
  registerWorkspaceCommands();
  registerTerminalCommands();
  registerDictationCommands();
  registerCapsuleCommands();
  // Defaults enable the scheduler and crash recovery; both need the profile to
  // be imported first, which `registerHostModules`' contract already guarantees.
  registerAutomationCommands();

  // `projects` owns the suggestion deck but deliberately knows nothing about
  // task history or provider credentials; both are handed in from outside.
  setSuggestionSupport(suggestionSupport);
}
