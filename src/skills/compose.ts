export type Skill = {
  name: string;
  description: string;
  instructions: string;
};

export type ComposeSystemOptions = {
  base: string;
  skills?: Array<Skill>;
};

export function composeSystem({ base, skills = [] }: ComposeSystemOptions): string {
  const sections = [base, ...skills.map(renderSkill)].filter((section) => section.trim().length > 0);
  return sections.join("\n\n");
}

function renderSkill(skill: Skill): string {
  return [
    `## Skill: ${skill.name}`,
    "",
    skill.instructions,
  ].join("\n");
}
