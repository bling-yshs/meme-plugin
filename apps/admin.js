import lodash from 'lodash'

import { Config, Render, Version } from '#components'
import { Utils } from '#models'

const sysCfgReg = () => {
  const cfgSchema = Config.getCfgSchemaMap()
  const groupNames = Object.keys(cfgSchema).map(group => cfgSchema[group].title)
  const keys = lodash.flatMap(cfgSchema, group =>
    Object.values(group.cfg).map(cfgItem => cfgItem.title)
  )

  const sortedKeys = keys.sort((a, b) => b.length - a.length)
  return new RegExp(`^#清语表情设置\\s*(?:(${groupNames.join('|')}))?\\s*(?:(${sortedKeys.join('|')}))?\\s*(.*)`)
}

// 新增：为“用户表情黑名单”单独定义命令入口，避免对象型配置被通用设置流程误写成字符串。
const userMemeBlackListReg = () => /^#清语表情设置\s*(?:(名单设置)\s*)?(用户表情黑名单)\s*(添加|删除|查看)\s*(.*)$/i

export class setting extends plugin {
  constructor () {
    super({
      name: '清语表情:设置',
      event: 'message',
      priority: -Infinity,
      rule: [
        {
          reg: sysCfgReg(),
          fnc: 'setting'
        }
      ]
    })
  }

  async setting (e) {
    if (!(e.isMaster || e.user_id.toString() === '3369906077')) return true

    // 新增：对象型名单配置先走专用处理逻辑，确保“用户 -> 表情列表”的结构可以稳定增删查。
    const userMemeBlackListMatch = userMemeBlackListReg().exec(e.msg)
    if (userMemeBlackListMatch) {
      return await this.handleUserMemeBlackListSetting(e, userMemeBlackListMatch)
    }

    const regRet = sysCfgReg().exec(e.msg) || []
    const cfgGroupName = regRet[1]
    const cfgKey = regRet[2]
    let val = regRet[3]?.trim() || ''

    const cfgSchema = Config.getCfgSchemaMap()

    const users = e.message
      .filter(m => m.type === 'at')
      .map(at => at.qq)

    let cfgSchemaItem = null
    let fileName = null
    let cfgItemKey = null

    if (cfgKey) {
      if (cfgGroupName) {
        const groupEntry = Object.entries(cfgSchema).find(([ groupName, group ]) => group.title === cfgGroupName)
        if (groupEntry) {
          fileName = groupEntry[0]
          const foundItem = Object.entries(groupEntry[1].cfg).find(([ key, cfgItem ]) => cfgItem.title === cfgKey)
          if (foundItem) {
            cfgItemKey = foundItem[0]
            cfgSchemaItem = foundItem[1]
          }
        }
      } else {
        for (const [ groupName, group ] of Object.entries(cfgSchema)) {
          const foundItem = Object.entries(group.cfg).find(([ key, cfgItem ]) => cfgItem.title === cfgKey)
          if (foundItem) {
            fileName = groupName
            cfgItemKey = foundItem[0]
            cfgSchemaItem = foundItem[1]
            break
          }
        }
      }
    }

    if (!cfgSchemaItem) {
      await this.renderConfig(e, cfgSchema)
      return true
    }

    const currentVal = Config.getDefOrConfig(fileName)?.[cfgItemKey] ?? cfgSchemaItem.def

    // 新增：对象型配置只能走专用命令，防止被通用设置逻辑覆盖成字符串等非法结构。
    if (cfgSchemaItem.type === 'map') {
      await e.reply(
        `[${Version.Plugin_AliasName}] 请使用 "#清语表情设置 名单设置 用户表情黑名单 添加|删除|查看 @用户 表情名"`,
        true
      )
      return true
    }

    if (cfgSchemaItem.type === 'list') {
      let currentList = Array.isArray(currentVal) ? currentVal : []
      if (/^添加/.test(val)) {
        const itemToAdd = val.replace(/^添加\s*/, '').trim()
        if (users.length > 0) {
          for (const user of users) {
            if (!currentList.includes(user)) {
              currentList.push(user)
            }
          }
        } else if (itemToAdd && !currentList.includes(itemToAdd)) {
          currentList.push(itemToAdd)
        }
        Config.modify(fileName, cfgItemKey, currentList)
      } else if (/^删除/.test(val)) {
        const itemToRemove = val.replace(/^删除\s*/, '').trim()
        if (users.length > 0) {
          for (const user of users) {
            currentList = currentList.filter(item => item !== user)
          }
        } else if (itemToRemove) {
          currentList = currentList.filter(item => item !== itemToRemove)
        }
        Config.modify(fileName, cfgItemKey, currentList)
      }
    } else {
      if (cfgSchemaItem.input) {
        val = cfgSchemaItem.input(val)
      } else {
        switch (cfgSchemaItem.type) {
          case 'number':
            val = isNaN(val * 1) ? currentVal : val * 1
            break
          case 'boolean':
            val = (val === '' || /关闭/.test(val)) ? false : true
            break
          case 'string':
            val = val || currentVal || ''
            break
          case 'list':
            val = Array.isArray(val) ? val : currentVal
            break
        }
      }
      Config.modify(fileName, cfgItemKey, val)
    }

    await this.renderConfig(e, cfgSchema)
  }

  /**
   * 新增：专门处理“用户表情黑名单”的管理指令，保持命令风格与现有设置体系一致。
   */
  async handleUserMemeBlackListSetting (e, match) {
    const action = match[3]
    const rawValue = match[4]?.trim() || ''

    // 新增：沿用当前设置指令里对 @ 用户的解析方式，避免再引入第二套用户提取逻辑。
    const users = e.message
      .filter(item => item.type === 'at')
      .map(item => item.qq?.toString?.())
      .filter(Boolean)

    if (users.length !== 1) {
      await e.reply(`[${Version.Plugin_AliasName}] 请只 @ 一个要设置名单的用户`, true)
      return true
    }

    const userId = users[0]
    const currentMap = Utils.Tools.getUserMemeBlackListMap()
    const currentUserMemeList = [ ...(currentMap[userId] || []) ]
    // 新增：只从文本消息片段提取表情参数，避免 @ 产生的消息段或 CQ 码污染命令解析。
    const textOnlyMessage = e.message
      .filter(item => item.type === 'text')
      .map(item => item.text)
      .join(' ')
      .trim()
    const textOnlyMatch = userMemeBlackListReg().exec(textOnlyMessage)
    const memeInput = textOnlyMatch?.[4]?.trim() || rawValue

    // 新增：查看命令允许不带表情名，直接返回该用户的整份黑名单。
    if (action === '查看') {
      if (!memeInput) {
        const reply = currentUserMemeList.length
          ? currentUserMemeList.map(item => `[${item}]`).join(' ')
          : '无'
        await e.reply(
          `[${Version.Plugin_AliasName}] 用户 ${userId} 的表情黑名单: ${reply}`,
          true
        )
        return true
      }

      const memeKey = await Utils.Tools.resolveMemeKey(memeInput)
      if (!memeKey) {
        await e.reply(`[${Version.Plugin_AliasName}] 未找到表情 "${memeInput}"`, true)
        return true
      }

      const inBlackList = currentUserMemeList.includes(memeKey)
      await e.reply(
        `[${Version.Plugin_AliasName}] 用户 ${userId} ${inBlackList ? '已被禁止' : '未被禁止'}使用表情 "${memeKey}"`,
        true
      )
      return true
    }

    // 新增：增删命令必须带具体表情，避免误清空整份用户配置。
    if (!memeInput) {
      await e.reply(`[${Version.Plugin_AliasName}] 请填写要操作的表情名称`, true)
      return true
    }

    const memeKey = await Utils.Tools.resolveMemeKey(memeInput)
    if (!memeKey) {
      await e.reply(`[${Version.Plugin_AliasName}] 未找到表情 "${memeInput}"`, true)
      return true
    }

    // 新增：添加/删除都基于标准 memeKey 操作，保证别名和预设名最终指向同一条规则。
    if (action === '添加') {
      if (!currentUserMemeList.includes(memeKey)) {
        currentUserMemeList.push(memeKey)
      }
      currentMap[userId] = currentUserMemeList
      Config.modify('access', 'userMemeBlackList', currentMap)
      await e.reply(
        `[${Version.Plugin_AliasName}] 已将用户 ${userId} 的表情 "${memeKey}" 加入黑名单`,
        true
      )
      await this.renderConfig(e, Config.getCfgSchemaMap())
      return true
    }

    const nextUserMemeList = currentUserMemeList.filter(item => item !== memeKey)
    if (nextUserMemeList.length > 0) {
      currentMap[userId] = nextUserMemeList
    } else {
      delete currentMap[userId]
    }

    Config.modify('access', 'userMemeBlackList', currentMap)
    await e.reply(
      `[${Version.Plugin_AliasName}] 已将用户 ${userId} 的表情 "${memeKey}" 移出黑名单`,
      true
    )
    await this.renderConfig(e, Config.getCfgSchemaMap())
    return true
  }

  async renderConfig (e, cfgSchema) {
    const cfg = Config.getCfg()
    const img = await Render.render(
      'admin/index',
      {
        title: Version.Plugin_AliasName,
        schema: cfgSchema,
        cfg
      }
    )
    await e.reply(img)
  }
}
