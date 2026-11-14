/** The team pages besides files: `/t/$teamId?view=…`. */
export const TEAM_VIEWS = ["trash", "fonts", "members"] as const;
export type TeamView = (typeof TEAM_VIEWS)[number];

export const isTeamView = (value: unknown): value is TeamView =>
  (TEAM_VIEWS as readonly unknown[]).includes(value);
