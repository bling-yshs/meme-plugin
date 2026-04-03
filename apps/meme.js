import { Config, Version } from '#components'
import { Meme, Utils } from '#models'

let memeRegExp, presetRegExp

/**
 * 生成正则表达式
 * @param {Function} getKeywords 获取关键词的函数
 * @returns {RegExp | null}
 */
const createRegex = async (getKeywords) => {
  const keywords = await getKeywords()
  if (!keywords) return null

  // 按长度对关键词进行排序，确保长关键词优先匹配
  keywords.sort((a, b) => b.length - a.length)

  const prefix = Config.meme.forceSharp ? '^#' : '^#?'
  const escapedKeywords = keywords.map((keyword) =>
    keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  return new RegExp(`${prefix}(${escapedKeywords.join('|')})(.*)`, 'i')
}

memeRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('meme'))
presetRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('preset'))

export class meme extends plugin {
  constructor () {
    super({
      name: '清语表情:表情包生成',
      event: 'message',
      priority: -Infinity,
      rule: []
    })

    this.rule.push(
      {
        reg: memeRegExp,
        fnc: 'meme'
      },
      {
        reg: presetRegExp,
        fnc: 'preset'
      }
    )
  }

  /**
   * 更新正则
   */
  async updateRegExp () {
    memeRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('meme'))
    presetRegExp = await createRegex(() => Utils.Tools.getAllKeyWords('preset'))

    this.rule = [
      {
        reg: memeRegExp,
        fnc: 'meme'
      },
      {
        reg: presetRegExp,
        fnc: 'preset'
      }
    ]

    return true
  }

  async meme (e) {
    return this.validatePrepareMeme(e, memeRegExp, Utils.Tools.getKey)
  }

  async preset (e) {
    return this.validatePrepareMeme(
      e,
      presetRegExp,
      Utils.Tools.getKey,
      true,
      'preset'
    )
  }

  /**
   * 通用处理函数, 用于验证权限获取需要的参数之类的
   */
  async validatePrepareMeme (
    e,
    regExp,
    getKeyFunc,
    isPreset = false,
    type = 'meme'
  ) {
    if (!Config.meme.enable) return false
    const message = (e.msg || '').trim()
    const match = message.match(regExp)
    if (!match) return false

    const matchedKeyword = match[1]
    const userText = match[2]?.trim() || ''
    if (!matchedKeyword) return false

    // 新增：先沿用原入口解析出目标 memeKey，后续统一权限判断与生成都复用这个标准 key。
    const memeKey = await getKeyFunc(matchedKeyword, type)
    if (!memeKey) return false

    // 新增：统一走工具层权限判定，把“用户权限 / 全局表情黑名单 / 用户表情黑名单”收敛到一条链路。
    const accessResult = await Utils.Tools.checkMemeAccess(e.user_id, memeKey)
    if (!accessResult.pass) {
      this.logAccessDenied(e.user_id, matchedKeyword, accessResult.reason)
      return false
    }

    const params = await Utils.Tools.getParams(memeKey)
    if (!params) return false

    /* 防误触发 */
    if (params.min_texts === 0 && params.max_texts === 0 && userText) {
      const trimmedText = userText.trim()
      if (
        !/^(@\s*\d+\s*)+$/.test(trimmedText) &&
        !/^(#\S+\s+[^#]+(?:\s+#\S+\s+[^#]+)*)$/.test(trimmedText)
      ) {
        return false
      }
    }

    const extraData = isPreset
      ? { Preset: await Utils.Tools.getPreseInfo(matchedKeyword) }
      : {}

    return this.makeMeme(e, memeKey, params, userText, isPreset, extraData)
  }

  /**
   * 新增：统一输出权限拒绝日志，方便区分是用户被禁用还是“某用户的某个表情”被禁用。
   */
  logAccessDenied (userId, keyword, reason) {
    // 新增：按拒绝原因输出更具体的日志，便于排查名单命中的是哪一层规则。
    switch (reason) {
      case 'user':
        logger.info(
          `[${Version.Plugin_AliasName}] 用户 ${userId} 没有权限，跳过生成`
        )
        break
      case 'global-meme':
        logger.info(
          `[${Version.Plugin_AliasName}] 表情 "${keyword}" 在全局禁用列表中，跳过生成`
        )
        break
      case 'user-meme':
        logger.info(
          `[${Version.Plugin_AliasName}] 用户 ${userId} 被禁止使用表情 "${keyword}"，跳过生成`
        )
        break
      default:
        logger.info(
          `[${Version.Plugin_AliasName}] 用户 ${userId} 触发表情 "${keyword}" 被拒绝`
        )
    }
  }

  /**
   * 调用 Meme 生成方法
   */
  async makeMeme (e, memeKey, params, userText, isPreset, extraData) {
    try {
      const result = await Meme.make(
        e,
        memeKey,
        params.min_texts,
        params.max_texts,
        params.min_images,
        params.max_images,
        params.default_texts,
        params.args_type,
        userText,
        isPreset,
        extraData
      )
      await e.reply(segment.image(result), Config.meme.reply)
      return true
    } catch (error) {
      logger.error(error.message)
      if (Config.meme.errorReply) {
        await e.reply(
          `[${Version.Plugin_AliasName}] 生成表情失败, 错误信息: ${error.message}`
        )
      }
      return false
    }
  }
}
