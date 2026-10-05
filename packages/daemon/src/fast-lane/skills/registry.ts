import type { Skill, SkillContext, Slots } from './types.js';

export class SkillRegistry {
  private readonly skills: Skill[] = [];

  register(skill: Skill): void {
    if (this.skills.some((s) => s.id === skill.id)) throw new Error(`skill ${skill.id} already registered`);
    this.skills.push(skill);
  }

  list(): readonly Skill[] {
    return this.skills;
  }

  /** The first skill (in registration order) whose strict extractor accepts the request. */
  async match(query: string, ctx: SkillContext): Promise<{ skill: Skill; slots: Slots } | null> {
    for (const skill of this.skills) {
      try {
        const slots = await skill.extract(query, ctx);
        if (slots !== null) return { skill, slots };
      } catch {
        // an extractor that fails is a skill that does not match
      }
    }
    return null;
  }
}
