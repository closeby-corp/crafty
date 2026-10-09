import { createUpdatePlugin } from 'crafty/plugins/update'

/** The example client is nested in this repository, so updates target its repository root. */
export default createUpdatePlugin({ repositoryDir: new URL('../../', import.meta.url) })
