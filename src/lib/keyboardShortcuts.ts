export interface ShortcutItem {
  id: string
  title: string
  description: string
  keys: string[][]
  context?: string
}

export interface ShortcutCategory {
  id: string
  title: string
  description: string
  shortcuts: ShortcutItem[]
}

export const MOD_KEY = '⌘/Ctrl'

export function getKeyboardShortcutCategories(sendWithEnter: boolean): ShortcutCategory[] {
  return [
    {
      id: 'global',
      title: 'Global',
      description: 'Navigation and app-wide panels',
      shortcuts: [
        {
          id: 'command-palette',
          title: 'Command palette',
          description: 'Search tasks and app actions from anywhere.',
          keys: [[MOD_KEY, 'K']],
        },
        {
          id: 'new-task',
          title: 'New task',
          description: 'Return to the start screen for a fresh task.',
          keys: [[MOD_KEY, 'N']],
        },
        {
          id: 'open-settings',
          title: 'Open settings',
          description: 'Open this settings panel.',
          keys: [[MOD_KEY, ',']],
        },
        {
          id: 'shortcuts-panel',
          title: 'Keyboard shortcuts',
          description: 'Open the searchable shortcuts overlay.',
          keys: [['?']],
        },
      ],
    },
    {
      id: 'workspace',
      title: 'Workspace',
      description: 'Current task surfaces',
      shortcuts: [
        {
          id: 'search-task',
          title: 'Find in current task',
          description: 'Search messages inside the active task.',
          keys: [[MOD_KEY, 'F']],
        },
        {
          id: 'toggle-computer',
          title: 'Toggle computer panel',
          description: 'Show or hide the browser, files, terminal, and preview area.',
          keys: [[MOD_KEY, 'Shift', 'C']],
        },
        {
          id: 'toggle-sidebar',
          title: 'Toggle sidebar',
          description: 'Collapse or expand the left navigation.',
          keys: [[MOD_KEY, 'Shift', 'E']],
        },
        {
          id: 'close-panel',
          title: 'Close panel',
          description: 'Close the topmost modal, panel, search, or menu.',
          keys: [['Esc']],
        },
      ],
    },
    {
      id: 'composer',
      title: 'Composer',
      description: 'Message input and saved skills',
      shortcuts: [
        {
          id: 'send-message',
          title: 'Send message',
          description: sendWithEnter
            ? 'Send from the composer. The alternate shortcut also works.'
            : 'Send from the composer when Enter is reserved for new lines.',
          keys: sendWithEnter ? [['Enter'], [MOD_KEY, 'Enter']] : [[MOD_KEY, 'Enter']],
        },
        {
          id: 'new-line',
          title: 'New line',
          description: sendWithEnter
            ? 'Insert a line break without sending.'
            : 'Insert a line break while Enter-to-send is off.',
          keys: sendWithEnter ? [['Shift', 'Enter']] : [['Enter'], ['Shift', 'Enter']],
        },
        {
          id: 'slash-menu',
          title: 'Saved skills',
          description: 'Open saved skill suggestions from any point in the prompt.',
          keys: [['/']],
        },
        {
          id: 'select-slash-command',
          title: 'Select suggestion',
          description: 'Choose the highlighted saved skill.',
          keys: [['Enter'], ['Tab']],
        },
      ],
    },
    {
      id: 'menus',
      title: 'Menus and Search',
      description: 'Command palette, saved skills, and search result navigation',
      shortcuts: [
        {
          id: 'move-selection',
          title: 'Move selection',
          description: 'Move through command palette, saved skill, and menu results.',
          keys: [['↑'], ['↓']],
        },
        {
          id: 'activate-selection',
          title: 'Open selected item',
          description: 'Activate the highlighted action, task, skill, or search result.',
          keys: [['Enter']],
        },
        {
          id: 'previous-search-match',
          title: 'Previous in-task match',
          description: 'Move upward through matches while current-task search is open.',
          keys: [['Shift', 'Enter']],
          context: 'Find in task',
        },
      ],
    },
    {
      id: 'home',
      title: 'Home',
      description: 'Starter actions before typing',
      shortcuts: [
        {
          id: 'home-quick-actions',
          title: 'Run a quick action',
          description: 'Pick one of the visible starter action buttons when the composer is not focused.',
          keys: [['1-8']],
        },
      ],
    },
  ]
}
