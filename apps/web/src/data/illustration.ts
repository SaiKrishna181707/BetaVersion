/** Design-only fixtures. These are not recorded sessions, metrics, or live browser activity. */
export const ILLUSTRATIVE_SESSIONS = [
  { id: '001', status: 'Exploring', tone: 'accent', page: 'Project overview', ability: 'Comfortable with technology', behavior: 'Scanning the page for a way to invite a teammate.', action: 'Looking for team settings', route: '/projects/launch', icon: 'cursor' },
  { id: '002', status: 'Retrying', tone: 'warning', page: 'Workspace settings', ability: 'New to project tools', behavior: 'Returned to settings after opening the wrong menu.', action: 'Trying another route', route: '/settings', icon: 'retry' },
  { id: '003', status: 'Completed', tone: 'neutral', page: 'Team members', ability: 'Familiar with project tools', behavior: 'Found the invite action and reached the objective.', action: 'Objective reached', route: '/settings/members', icon: 'check' },
] as const;
