export type IconDef = {
  token: string;
  color?: string;
};

export type ColumnDef = Record<string, unknown>;

export function markdown(content: string, opts?: { icon?: IconDef; size?: string }): Record<string, unknown> {
  return {
    tag: "markdown",
    content,
    text_align: "left",
    text_size: opts?.size ?? "normal_v2",
    margin: "0px 0px 0px 0px",
    ...(opts?.icon ? { icon: standardIcon(opts.icon.token, opts.icon.color) } : {}),
  };
}

export function columnSet(columns: ColumnDef[]): Record<string, unknown> {
  return {
    tag: "column_set",
    horizontal_spacing: "8px",
    horizontal_align: "left",
    columns,
    margin: "0px 0px 0px 0px",
  };
}

export function column(elements: Record<string, unknown>[], opts?: { bg?: string; weight?: number }): Record<string, unknown> {
  return {
    tag: "column",
    width: opts?.weight ? "weighted" : "auto",
    ...(opts?.weight ? { weight: opts.weight } : {}),
    ...(opts?.bg ? { background_style: opts.bg } : {}),
    elements,
    padding: "8px 8px 8px 8px",
    direction: "vertical",
    horizontal_spacing: "8px",
    vertical_spacing: "8px",
    horizontal_align: "left",
    vertical_align: "top",
    margin: "0px 0px 0px 0px",
  };
}

export function divider(): Record<string, unknown> {
  return {
    tag: "hr",
  };
}

export function standardIcon(token: string, color = "grey"): Record<string, unknown> {
  return {
    tag: "standard_icon",
    token,
    color,
  };
}
