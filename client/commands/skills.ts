/** Enables the optional client-owned skills discovery and installer plugin. */
import { createSkillsPlugin } from 'crafty/plugins/skills'

export default createSkillsPlugin({ skillsDir: new URL('../skills/', import.meta.url) })
