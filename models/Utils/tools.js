import chalk from 'chalk'

import { Config } from '#components'
import { db, Meme, Utils } from '#models'

// 新增：统一把用户 ID 转成字符串，避免配置里数字/字符串混用导致权限判断失效。
const normalizeUserId = (userId) => userId?.toString?.() || ''

// 新增：统一规整“用户表情黑名单”配置，保证后续读取时始终是 userId => string[] 的稳定结构。
const normalizeUserMemeBlackListMap = (config = {}) => {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {}
  }

  return Object.entries(config).reduce((result, [ userId, memeList ]) => {
    const normalizedUserId = normalizeUserId(userId)
    const normalizedMemeList = Array.isArray(memeList)
      ? [ ...new Set(memeList.map(item => item?.toString?.()).filter(Boolean)) ]
      : []

    if (normalizedUserId && normalizedMemeList.length > 0) {
      result[normalizedUserId] = normalizedMemeList
    }

    return result
  }, {})
}

const Tools = {
  /**
   * 获取表情包请求的基础 URL
   * @returns {Promise<string>} - 返回表情包基础 URL
   */
  async getBaseUrl () {
    if (!Config.server.url) throw new Error('未设置表情包API')
    return Config.server?.url?.replace(/\/+$/, '')
  },

  /**
   * 初始化表情包数据
   * 如果数据已加载则直接返回，否则从本地或远程加载表情包数据
   * @returns {Promise<void>}
   */
  async init () {
    logger.debug(chalk.cyan('🚀 开始加载表情包数据...'))

    const [ memeData, argData ] = await Promise.all([
      db.meme.getAll(),
      db.preset.getAll()
    ])

    const tasks = []
    if (!memeData?.length) {
      logger.debug(chalk.cyan('🚀 表情包数据不存在，开始生成...'))
      tasks.push(this.generateMemeData(true))
    } else {
      logger.debug(chalk.cyan('✅ 表情包数据已存在，加载完成'))
    }

    if (!argData?.length) {
      logger.debug(chalk.cyan('🚀 参数数据不存在，开始生成...'))
      tasks.push(this.generatePresetData())
    } else {
      logger.debug(chalk.cyan('✅ 参数数据已存在，加载完成'))
    }

    if (tasks.length) await Promise.all(tasks)
  },

  /**
   * 生成本地表情包数据
   * @param {boolean} forceUpdate - 是否进行全量更新数据, 默认为增量更新数据
   * @returns {Promise<void>}
   */
  async generateMemeData (forceUpdate = false) {
    try {
      const baseUrl = await this.getBaseUrl()
      if (!baseUrl) {
        logger.error('❌ 无法获取表情包请求基础路径')
        return
      }

      logger.info(chalk.magenta.bold('🌟 开始生成表情包数据...'))

      const localKeys = forceUpdate
        ? new Set()
        : new Set(await this.getAllKeys())

      const remoteKeysResponse = await Utils.Request.get(
        `${baseUrl}/memes/keys`
      )
      if (!remoteKeysResponse.success || !remoteKeysResponse.data.length) {
        logger.warn('⚠️ 未获取到任何表情包键值，跳过数据更新。')
        return
      }
      const remoteKeys = new Set(remoteKeysResponse.data)

      const keysToUpdate = forceUpdate
        ? [ ...remoteKeys ]
        : [ ...remoteKeys ].filter((key) => !localKeys.has(key))

      const keysToDelete = [ ...localKeys ].filter((key) => !remoteKeys.has(key))

      if (!keysToUpdate.length && !keysToDelete.length) {
        logger.info(chalk.cyan('✅ 表情包数据已是最新，无需更新或删除。'))
        return
      }

      logger.debug(
        chalk.magenta(`🔄 需要更新 ${keysToUpdate.length} 个表情包`)
      )
      logger.debug(chalk.red(`🗑️  需要删除 ${keysToDelete.length} 个表情包`))

      if (keysToDelete.length) {
        await this.removeKey(keysToDelete)
        logger.info(chalk.yellow(`🗑️ 已删除 ${keysToDelete.length} 个表情包`))
      }

      const processValue = (value) => {
        if (Array.isArray(value) && value.length === 0) return null
        if (
          typeof value === 'object' &&
          value !== null &&
          Object.keys(value).length === 0
        )
          return null
        return value
      }

      await Promise.all(
        keysToUpdate.map(async (key) => {
          const infoResponse = await Utils.Request.get(
            `${baseUrl}/memes/${key}/info`
          )
          if (!infoResponse.success) {
            logger.error(
              `❌ 获取表情包详情失败: ${key} - ${infoResponse.message}`
            )
            return
          }

          const info = infoResponse.data

          const keyWords = processValue(info.keywords)
          const tags = processValue(info.tags)
          const params = processValue(info.params_type)

          const min_texts = params?.min_texts ?? null
          const max_texts = params?.max_texts ?? null
          const min_images = params?.min_images ?? null
          const max_images = params?.max_images ?? null
          const defText = processValue(params?.default_texts)
          const args_type = params?.args_type ?? null

          await db.meme.add(
            key,
            info,
            keyWords,
            params,
            min_texts,
            max_texts,
            min_images,
            max_images,
            defText,
            args_type,
            tags,
            { force: true }
          )
        })
      )

      logger.info(chalk.green.bold('✅ 表情包数据更新完成！'))
    } catch (error) {
      logger.error(`❌ 生成本地表情包数据失败: ${error.message}`)
      throw error
    }
  },

  /**
   * 生成预设参数数据
   * @returns {Promise<void>}
   */
  async generatePresetData () {
    try {
      logger.debug(chalk.blue.bold('🛠️ 开始生成预设参数数据...'))
      const preset = Meme.preset
      await db.preset.removeAll()
      await Promise.all(
        preset.map(async (preset) => {
          await db.preset.add(
            preset.name,
            preset.key,
            preset.arg_name,
            preset.arg_value
          )
        })
      )
      logger.debug(chalk.green.bold(`✅ 成功写入 ${preset.length} 条预设数据`))
    } catch (error) {
      logger.error(`❌ 预设数据生成失败: ${error.message}`)
      throw error
    }
  },

  /**
   * 发送表情包生成请求
   */
  async request (endpoint, params = {}, responseType = 'arraybuffer') {
    const baseUrl = await this.getBaseUrl()
    const url = `${baseUrl}/memes/${endpoint}/`

    const isFormData = params instanceof FormData
    const headers = responseType ? { Accept: responseType } : {}

    return Utils.Request.post(
      url,
      params,
      isFormData ? undefined : headers,
      responseType
    )
  },

  /**
   * 获取表情包的预览图片地址
   * @param {string} memeKey - 表情包的唯一标识符
   * @returns {Promise<string|null>} - 返回预览图片的 URL 或 null
   */
  async getPreviewUrl (memeKey) {
    return memeKey
      ? `${await this.getBaseUrl()}/memes/${memeKey}/preview`.trim()
      : null
  },

  /**
 * 将关键字转换为表情包键
 * @param {string} keyword - 表情包关键字
 * @param {string} [type='meme'] - 可选参数，决定从哪个数据源获取，'meme' 或 'preset'（默认 'meme'）
 * @returns {string|null} - 返回对应的表情包键或 null
 */
  async getKey (keyword, type = 'meme') {
    const dbField = type === 'preset' ? db.preset : db.meme
    const fieldName = type === 'preset' ? 'name' : 'keyWords'
    const key = type === 'preset' ? 'key' : 'key'

    // 新增：只取第一条命中的 key，避免旧实现把数组强转字符串后产生空串或脏值。
    const result = await dbField.getByField(fieldName, keyword, key)
    return result?.[0] ?? null
  },

  /**
   * 新增：把关键词、别名、预设名统一解析成真实 memeKey，避免名单判断依赖调用方传参形式。
   * @param {string} input - 用户输入的表情 key、别名或预设名
   * @returns {Promise<string|null>} - 返回标准化后的 memeKey
   */
  async resolveMemeKey (input) {
    if (!input) return null

    const exactKey = await db.meme.getByKey(input, 'key')
    if (exactKey) return exactKey

    return (
      (await this.getKey(input, 'meme')) ||
      (await this.getKey(input, 'preset')) ||
      null
    )
  },
  /**
   * 获取指定表情包的关键字
   * @param {string} memeKey - 表情包的唯一标识符
   * @returns {string[]|null} - 返回表情包关键字数组或 null
   */
  async getKeyWords (memeKey) {
    return JSON.parse(await db.meme.getByKey(memeKey, 'keyWords')) || null
  },

  /**
 * 获取所有的关键词
 * @param {string} [type='meme'] - 可选参数，决定从哪个数据库获取，'meme' 或 'preset'（默认 'meme'）
 * @returns {Promise<Array<string>>} - 返回包含所有关键词的数组
 */
  async getAllKeyWords (type = 'meme') {
    const keyWordsList = type === 'preset'
      ? await db.preset.getAllSelect('name')
      : await db.meme.getAllSelect('keyWords')

    return keyWordsList.map((item) => JSON.parse(item)).flat() || null
  },


  /**
   * 获取所有的 key
   * @returns {Array<string>} - 返回所有的表情包 key 的数组
   */
  async getAllKeys () {
    const keyList = await db.meme.getAllSelect('key')

    return keyList.flat() || null
  },

  /**
   * 获取快捷指令信息
   * @param {string} name - 表情包的唯一标识符(快捷指令)
   * @returns {Promise<object|null>} -返回快捷指令信息
   */
  async getPreseInfo (name) {
    return await db.preset.get(name)
  },

  /**
   * 获取所有的快捷指令信息
   * @param {string} memeKey - 表情的键值
   * @returns {Promise<Array<string>>} - 返回包含所有关键词的数组
   */
  async gatPresetAllName (memeKey) {
    const nameList = await db.preset.getAllByKey(memeKey) ?? []
    return nameList.map((item) => JSON.parse(item.name)) || null
  },

  /**
   * 获取表情包的参数类型
   * @param {string} memeKey - 表情包的键值
   * @returns {Promise<object|null>} - 返回参数类型信息或 null
   */
  async getParams (memeKey) {
    if (!memeKey) return null

    const memeParams = await db.meme.getByKey(memeKey, 'params')

    if (!memeParams) {
      return null
    }

    const {
      min_texts,
      max_texts,
      min_images,
      max_images,
      default_texts,
      args_type
    } = JSON.parse(memeParams)

    return (
      {
        min_texts,
        max_texts,
        min_images,
        max_images,
        default_texts,
        args_type
      } || null
    )
  },
  /**
   * 获取指定表情包参数的类型
   * @param {string} key - 表情包的唯一标识符
   * @param {string} paramName - 参数名称
   * @returns {string|null} - 返回参数的类型或 null
   */
  async getParamInfo (key) {
    const { args_type } = await this.getParams(key)

    if (!args_type || !args_type.args_model) {
      return []
    }

    const argsModel = args_type.args_model
    const properties = argsModel.properties || {}

    return Object.entries(properties)
      .filter(([ name ]) => name !== 'user_infos')
      .map(([ name, paramInfo ]) => ({
        name,
        description: paramInfo.description || null
      }))
  },

  /**
   * 获取指定 key 的参数描述信息
   * @param {string} key - 需要获取描述的 key。
   * @returns {object|null} - 返回描述信息
   */
  async getDescriptions (key) {
    const params = await this.getParamInfo(key)

    if (!params || params.length === 0) {
      return null
    }

    return params.reduce((acc, { name, description }) => {
      acc[name] = description
      return acc
    }, {})
  },


  /**
   * 获取对应表情的表情
   * @param {string} key
   * @returns {string[]|null} 返回对应表情的表情
   */
  async getTags (key) {
    return JSON.parse(await db.meme.getByKey(key, 'tags')) || null
  },

  /**
   * 获取对应表情的默认文本
   * @param {string} key
   * @returns {string[]|null} 返回对应表情的默认文本
   */
  async getDeftext (key) {
    return JSON.parse(await db.meme.getByKey(key, 'defText')) || null
  },

  /**
   * 删除指定key的表情
   * @param {string||string[]} key
   * @returns {boolean}
   */
  async removeKey (keys) {
    if (!Array.isArray(keys)) {
      keys = [ keys ]
    }
    await Promise.all(keys.map((key) => db.meme.remove(key)))
  },

  /**
   * 新增：读取并规整“用户表情黑名单”配置，统一供管理指令和运行时权限检查复用。
   * @returns {Record<string, string[]>} - 返回 userId => memeKey[] 的映射
   */
  getUserMemeBlackListMap () {
    return normalizeUserMemeBlackListMap(Config.access.userMemeBlackList)
  },

  /**
   * 新增：获取指定用户的表情黑名单列表。
   * @param {string|number} userId - 用户 ID
   * @returns {string[]} - 返回该用户被禁用的 memeKey 列表
   */
  getUserMemeBlackList (userId) {
    const normalizedUserId = normalizeUserId(userId)
    return this.getUserMemeBlackListMap()[normalizedUserId] || []
  },

  /**
   * 检查输入是否在禁用表情包列表中
   * @param {string} input - 输入的关键字或表情包键
   * @returns {Promise<boolean>} - 如果在禁用列表中返回 true，否则返回 false
   */
  async isBlacklisted (input) {
    const blacklistedKeys = await Promise.all(
      Config.access.blackList.map(async (item) => {
        // 新增：全局黑名单也统一转换成 memeKey，避免别名和预设名绕过限制。
        return (await this.resolveMemeKey(item)) || item
      })
    )

    // 新增：运行时同样统一按 memeKey 比较，避免调用方传关键词和 key 时结果不一致。
    const memeKey = await this.resolveMemeKey(input)
    return blacklistedKeys.filter(Boolean).includes(memeKey || input)
  },

  /**
   * 新增：检查某个用户是否被单独禁止使用指定表情。
   * @param {string|number} userId - 用户 ID
   * @param {string} input - 表情 key、别名或预设名
   * @returns {Promise<boolean>} - 命中用户表情黑名单时返回 true
   */
  async isUserMemeBlacklisted (userId, input) {
    const memeKey = await this.resolveMemeKey(input)
    if (!memeKey) return false

    return this.getUserMemeBlackList(userId).includes(memeKey)
  },

  /**
   * 新增：统一处理“插件用户权限 + 全局表情黑名单 + 用户表情黑名单”的完整判定链路。
   * @param {string|number} userId - 用户 ID
   * @param {string} input - 表情 key、别名或预设名
   * @returns {Promise<{pass: boolean, reason: string|null, memeKey: string|null}>} - 返回判定结果及标准 memeKey
   */
  async checkMemeAccess (userId, input) {
    const normalizedUserId = normalizeUserId(userId)
    const normalizedWhiteList = (Config.access.userWhiteList || []).map(item => normalizeUserId(item))
    const normalizedBlackList = (Config.access.userBlackList || []).map(item => normalizeUserId(item))
    const memeKey = await this.resolveMemeKey(input)

    // 新增：先判断插件级用户权限，保持原有黑白名单能力不变。
    if (
      Config.access.enable &&
      (
        (Config.access.mode === 0 && !normalizedWhiteList.includes(normalizedUserId)) ||
        (Config.access.mode === 1 && normalizedBlackList.includes(normalizedUserId))
      )
    ) {
      return { pass: false, reason: 'user', memeKey }
    }

    // 新增：再判断全局表情黑名单，保留“所有人都不能用”的管理能力。
    if (Config.access.blackListEnable && await this.isBlacklisted(memeKey || input)) {
      return { pass: false, reason: 'global-meme', memeKey }
    }

    // 新增：最后判断用户-表情粒度的黑名单，实现“只屏蔽某个人的某个表情”。
    if (await this.isUserMemeBlacklisted(normalizedUserId, memeKey || input)) {
      return { pass: false, reason: 'user-meme', memeKey }
    }

    return { pass: true, reason: null, memeKey }
  }
}

export { Tools }
