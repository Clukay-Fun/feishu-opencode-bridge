/**
 * 职责: 提供回复清理与证据文本脱敏工具。
 * 关注点:
 * - 清除不应暴露给用户的系统提示残留。
 * - 对证据材料中的敏感信息做统一脱敏处理。
 */
//#region Assistant output
// Remove bridge-only reminders and collapse extra blank lines before replying.
export function cleanAssistantReply(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
//#endregion

//#region Evidence redaction
// Redact sensitive fields from free-form evidence text before downstream use.
export function redactEvidenceText(text: string): string {
  return text
    .replace(/(?:(甲方|乙方|委托人|受托方|客户名称|公司名称|用人单位|单位名称|对方当事人|对方)[:：]\s*)([^\n；;，。]+?(?:有限责任公司|股份有限公司|集团有限公司|有限公司|律师事务所|事务所|集团|公司))/g, (_match, label: string, value: string) => {
      return `${label}：${maskOrganizationName(value.trim())}`;
    })
    .replace(/\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_match, local: string, domain: string) => {
      const head = local.slice(0, 1);
      return `${head}***@${domain}`;
    })
    .replace(/(?<![A-Za-z0-9])([\u4e00-\u9fa5A-Za-z0-9（）()·\s-]{2,40}?(?:有限责任公司|股份有限公司|集团有限公司|有限公司|律师事务所|事务所|集团|公司))(?![A-Za-z0-9])/g, (_match, value: string) => {
      return maskOrganizationName(value.trim());
    })
    .replace(/(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g, "$1****$3")
    .replace(/(?<!\d)(\d{6})(\d{8})([\dXx]{4})(?!\d)/g, "$1********$3")
    .replace(/(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g, "$1 **** **** $2")
    .replace(/(?:(姓名|联系人|员工|申请人|被申请人|当事人)[:：]\s*)([\u4e00-\u9fa5]{2,4})/g, (_match, label: string, name: string) => {
      return `${label}：${maskChineseName(name)}`;
    })
    .replace(/(?:(地址|住址|收件地址|身份证号|联系方式|手机号|电话|邮箱|银行卡号|银行账号)[:：]\s*)([^\n；;]+)/g, (_match, label: string, value: string) => {
      return `${label}：${maskLabeledValue(label, value.trim())}`;
    });
}

// Apply field-aware redaction across a structured evidence record.
export function redactEvidenceRecord<T extends Record<string, unknown>>(record: T): T {
  const result: Record<string, unknown> = { ...record };
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "string") {
      result[key] = redactEvidenceField(key, value);
      continue;
    }
    if (Array.isArray(value)) {
      result[key] = value.map((item) => typeof item === "string" ? redactEvidenceField(key, item) : item);
    }
  }
  return result as T;
}

// Choose between field-aware masking and generic text redaction.
function redactEvidenceField(field: string, value: string): string {
  if (isSensitiveField(field)) {
    return maskLabeledValue(field, value.trim());
  }
  return redactEvidenceText(value);
}

// Detect whether a structured field name should always be redacted.
function isSensitiveField(field: string): boolean {
  return /姓名|联系人|联系方式|手机号|电话|邮箱|地址|住址|身份证|银行卡|账号|客户名称|公司名称|用人单位|对方当事人|委托人|甲方|乙方/.test(field);
}

// Replace personal names with a fixed placeholder.
function maskChineseName(value?: string): string {
  void value;
  return "XXX";
}

// Pick the right masking strategy based on a labeled field.
function maskLabeledValue(label: string, value: string): string {
  if (/客户名称|公司名称|用人单位|对方当事人|甲方|乙方/.test(label)) {
    return maskOrganizationName(value);
  }
  if (/委托人/.test(label)) {
    return looksLikeOrganization(value) ? maskOrganizationName(value) : maskChineseName(value);
  }
  if (/姓名|联系人|员工|申请人|被申请人|当事人/.test(label)) {
    return maskChineseName(value);
  }
  if (/联系方式|手机号|电话/.test(label)) {
    return value.replace(/(?<!\d)(1[3-9]\d)(\d{4})(\d{4})(?!\d)/g, "$1****$3");
  }
  if (/邮箱/.test(label)) {
    return value.replace(/\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g, (_match, local: string, domain: string) => `${local.slice(0, 1)}***@${domain}`);
  }
  if (/身份证/.test(label)) {
    return value.replace(/(?<!\d)(\d{6})(\d{8})([\dXx]{4})(?!\d)/g, "$1********$3");
  }
  if (/银行卡|账号/.test(label)) {
    return value.replace(/(?<!\d)(\d{4})\d{8,11}(\d{4})(?!\d)/g, "$1 **** **** $2");
  }
  if (/地址|住址/.test(label)) {
    return value.length > 8 ? `${value.slice(0, 6)}****` : `${value.slice(0, 2)}***`;
  }
  return redactEvidenceText(value);
}

// Heuristically detect whether a value looks like an organization name.
function looksLikeOrganization(value: string): boolean {
  return /(有限责任公司|股份有限公司|集团有限公司|有限公司|律师事务所|事务所|集团|公司)/.test(value);
}

// Replace organization names while preserving coarse entity type.
function maskOrganizationName(value: string): string {
  if (/律师事务所|事务所/.test(value)) {
    return "XXX机构";
  }
  if (/(有限责任公司|股份有限公司|集团有限公司|有限公司|集团|公司)/.test(value)) {
    return "XXX公司";
  }
  return "XXX单位";
}
//#endregion
