export const pluginTitle = '企微消息图谱';
export const phaseLabels = {idle: '等待选择', syncing: '正在同步', ready: '同步正常', paused: '同步已暂停', retrying: '等待重试'};
const errors: Record<string, string> = {
  agent_invalid_workspace: '请输入存在的本机工作目录。',
  agent_scope_required: '请先保存此工作目录的群聊授权。',
  agent_archive_unavailable: '对应的企业档案暂时无法读取。',
  agent_conversation_unavailable: '授权范围内有会话无法读取。',
  agent_copilot_scope_required: '请先在「Agent 记忆」中授权此会话。',
  agent_copilot_index_required: '会话索引还未建好，请在「Agent 记忆」中查看进度。',
  agent_copilot_no_evidence: '当前会话的索引里没有可用于回答的消息。',
  agent_copilot_model_required: '请先在 DSH 设置中配置默认模型。',
  agent_copilot_model_failed: '默认模型暂时没有返回可用回答，请检查模型配置或稍后重试。',
  agent_copilot_connection_lost: '回答中断了，可以重新提问。',
  agent_source_unavailable: '原消息已无法验证，可能已清理或超出授权范围。',
  agent_scope_changed: '授权范围已变更，请重试。',
  agent_index_busy: '正在建立索引，请稍后重试。',
  agent_index_failed: '索引未完成，保留上一次可用结果。',
  agent_memory_unavailable: '这条记忆已移除或无法确认。',
  agent_grant_limit: '此范围的客户端授权已达上限，请撤销不再使用的授权。',
  backend_unavailable: '本地数据服务暂时不可用。',
  backend_protocol_error: '本地数据服务返回了无法识别的结果。',
  vid_not_verified: '没有找到能解开此档案的 VID。',
  contacts_missing: '未找到联系人库，消息仍可浏览。',
  conversations_missing: '未找到会话库，按消息中的会话编号分组。',
  contacts_key_unverified: '联系人库未通过 VID 校验。',
  conversations_key_unverified: '会话库未通过 VID 校验。',
  source_busy: '源文件正被占用，稍后重试。',
  source_changed: '源文件正在写入，稍后重试。',
  source_unreadable: '暂时无法读取源文件，请检查本机文件访问权限。',
  source_access_denied: '无法访问企业微信数据。请在系统提示中授权后重新扫描。',
  local_only: `请从本机 DSH 打开「${pluginTitle}」。`,
  unsupported_platform: '这个插件包需要在 macOS 上运行。',
  unsupported_schema: '源数据库表结构暂未支持。',
  database_missing: '源数据库暂时不可用。',
  source_too_large: '源文件超过 512 MiB。',
  database_size_limit: '重建后的数据库超过 512 MiB。',
  sqlite_integrity_failed: '数据库完整性检查未通过。',
  wal_validation_failed: 'WAL 校验未通过。',
  export_not_ready: '档案还没有可以导出的有效快照。',
  export_profile_changed: '当前企业已切换，请重新选择导出。',
  export_inside_source: '请选择企业微信数据目录之外的保存位置。',
  export_failed: '明文数据库导出失败，请检查保存位置和可用空间。',
};
export const describe = (error: unknown) => errors[String(error)] ?? '本次读取未完成，请检查档案和同步状态。';
export const formatNumber = new Intl.NumberFormat('zh-CN');
export const clock = new Intl.DateTimeFormat('zh-CN', {hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
const date = new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit'});
export const fullDate = new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'long', day: 'numeric'});
export const toDate = (time: number) => {
  const value = new Date(time * 1000);
  return Number.isFinite(value.getTime()) && time > 0 ? value : null;
};
export function shortDate(value: number) {
  const stamp = toDate(value);
  if (!stamp) return '';
  const now = new Date();
  if (stamp.toDateString() !== now.toDateString()) return date.format(stamp);
  const minutes = Math.floor((now.getTime() - stamp.getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  return minutes < 60 ? `${minutes}分钟前` : clock.format(stamp);
}
