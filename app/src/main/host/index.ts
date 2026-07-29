/**
 * Host command modules, gathered in one place.
 *
 * Every module registers its own slice of the Tauri command surface. They are
 * independent of each other except for the suggestion support that `projects`
 * needs injected, which is why the wiring lives here rather than inside any of
 * them: only the integration layer knows about all three at once.
 */

import { registerConversationCommands } from "./conversations.js";
import { registerProjectCommands, setSuggestionSupport } from "./projects.js";
import { registerSettingsCommands } from "./settings.js";
import { registerSkillsCommands } from "./skills.js";
import { registerTietiezhiCommands } from "./tietiezhi.js";
import { suggestionSupport } from "./suggestions.js";

export { dataDir, importLegacyDataOnce } from "./paths.js";

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

  // `projects` owns the suggestion deck but deliberately knows nothing about
  // task history or provider credentials; both are handed in from outside.
  setSuggestionSupport(suggestionSupport);
}
