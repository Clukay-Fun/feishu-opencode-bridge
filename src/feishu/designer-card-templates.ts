/**
 * 职责: 承载飞书卡片设计器导出的用户侧卡片模板。
 * 关注点:
 * - 保留 .card 文件中的原始结构、颜色、padding 和 icon。
 * - 供各业务 builder 做最小变量替换，避免代码侧重新发明样式。
 * - 不在这里承载业务逻辑或运行时发送行为。
 */

export const DESIGNER_CARD_TEMPLATES = {
  "二次审查完成": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "markdown",
          "content": "案件：**张三违法解除劳动合同争议**",
          "text_align": "left",
          "text_size": "normal_v2"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "red-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**高风险问题（1项）** ",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "spam_outlined",
                    "color": "red"
                  }
                },
                {
                  "tag": "markdown",
                  "content": "> 工资基数缺少来源",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "wathet-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**中风险问题（1项）** ",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "spam_outlined",
                    "color": "blue"
                  }
                },
                {
                  "tag": "markdown",
                  "content": "> 经济补偿计算未引用第四十七条",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "green-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**低风险问题（0项）** ",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "spam_outlined",
                    "color": "green"
                  }
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "打开分析文档"
          },
          "type": "primary",
          "width": "fill",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right-bold_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "二次审查完成"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "耗时 2m 5s"
          },
          "color": "green"
        }
      ],
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "feed-read_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "二次审查进行中": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "案件：**张三违法解除劳动合同争议**",
                  "text_align": "left",
                  "text_size": "normal_v2"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "background_style": "grey-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "权威法规检索：已完成",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "法条引用校验：进行中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "default"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "loading_outlined",
                    "color": "blue"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "请求权基础校验：等待中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "二次审查进行中"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "今日待办": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "background_style": "red-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**举证期限截止** 明天 17:00\n张三劳动争议案 · 需补充工资流水证据",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "查看记录"
                  },
                  "type": "text",
                  "width": "default",
                  "size": "tiny",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "right-bold_outlined"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "0px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "background_style": "yellow-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**开庭提醒** 04-18 09:30\n张三劳动争议案 · 需补充工资流水证据",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "查看记录"
                  },
                  "type": "text",
                  "width": "default",
                  "size": "tiny",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "right-bold_outlined"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "0px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "background_style": "wathet-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**合同付款** 04-20\n委托代理合同 · 首期代理费 ¥10,000 待收",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "查看记录"
                  },
                  "type": "text",
                  "width": "default",
                  "size": "tiny",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "right-bold_outlined"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "0px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "background_style": "grey-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**证据补充** 04-25 前\n张三劳动争议案 · 社保缴纳记录待获取",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "查看记录"
                  },
                  "type": "text",
                  "width": "default",
                  "size": "tiny",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "right-bold_outlined"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "今日待办"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "3 项"
          },
          "color": "orange"
        }
      ],
      "template": "orange",
      "icon": {
        "tag": "standard_icon",
        "token": "alarm-clock_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "发票识别": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "elements": [
        {
          "tag": "markdown",
          "content": "正在识别：`260324_291.94_上海稀宇科技有限公司.pdf`",
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "loading_outlined",
            "color": "blue"
          }
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "已完成xxx",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "正在 OCR 识别发票内容…",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "default"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "loading_outlined",
                    "color": "blue"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "等待填写表格…",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "识别完成：`260405_635.00_深圳市南山区肖三胖甲鱼院子.pdf`",
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "yes_outlined",
            "color": "green"
          }
        },
        {
          "tag": "markdown",
          "content": "识别错误：`260415_875.00_广东徐记海鲜餐饮有限公司.pdf`",
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "more-close_outlined",
            "color": "red"
          }
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "发票识别"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "发票识别完成": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "elements": [
        {
          "tag": "markdown",
          "content": "260324_291.94_上海稀宇科技有限公司.pdf",
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "file-link-word_outlined",
            "color": "green"
          }
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**发票号：** 26312000001781272876\n**发票类型：** 服务\n**金额：** 291.94\n**开票时间：** 2026/03/24",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "**xx合同.pdf**   识别失败，非发票文件",
          "text_align": "left",
          "text_size": "normal_v2",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "more-close_outlined",
            "color": "red"
          }
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "查看发票表"
          },
          "type": "primary",
          "width": "default",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right-bold_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "发票识别完成"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "耗时 32s"
          },
          "color": "green"
        }
      ],
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "feed-read_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "可用模型": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**OpenAI 模型**",
                  "text_align": "left",
                  "text_size": "normal"
                },
                {
                  "tag": "column_set",
                  "flex_mode": "stretch",
                  "horizontal_spacing": "12px",
                  "horizontal_align": "left",
                  "columns": [
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "grey-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "gpt-5.4",
                          "text_align": "left",
                          "text_size": "normal"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "4px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    },
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "grey-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "gpt-5.3-codex",
                          "text_align": "left",
                          "text_size": "normal"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    }
                  ],
                  "margin": "0px 0px 8px 0px"
                },
                {
                  "tag": "markdown",
                  "content": ">切换示例：openai/gpt-5.5",
                  "text_align": "left",
                  "text_size": "notation"
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**OpenCode Zen 模型**",
                  "text_align": "left",
                  "text_size": "normal"
                },
                {
                  "tag": "column_set",
                  "flex_mode": "stretch",
                  "horizontal_spacing": "12px",
                  "horizontal_align": "left",
                  "columns": [
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "grey-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "MiniMax-M2.7",
                          "text_align": "left",
                          "text_size": "normal"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "4px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    },
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "grey-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "big-pickle",
                          "text_align": "left",
                          "text_size": "normal"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    },
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "grey-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "nemotron-3-super-free",
                          "text_align": "left",
                          "text_size": "normal"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    }
                  ],
                  "margin": "0px 0px 8px 0px"
                },
                {
                  "tag": "markdown",
                  "content": ">切换示例：opencode/gpt-5.5",
                  "text_align": "left",
                  "text_size": "notation"
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "发送 `/model use <provider>/model` 切换模型。",
          "text_align": "left",
          "text_size": "notation",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "efficiency_outlined",
            "color": "grey"
          }
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "可用模型"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": "当前：minimax-coding-plan/minimax2.7"
      },
      "template": "indigo",
      "icon": {
        "tag": "standard_icon",
        "token": "ai-common_colorful"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "合同起草": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**委托代理合同（张三 vs 北京XX科技）**",
                  "text_align": "left",
                  "text_size": "heading",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "劳动争议",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "仲裁",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "律师费：¥20,000",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "填充变量并生成文档",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "default"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "loading_outlined",
                    "color": "blue"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "解析起草需求",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "同步合同台账",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "合同起草"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "合同起草完成": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**委托代理合同（张三 vs 北京XX科技）**",
                  "text_align": "left",
                  "text_size": "heading",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "劳动争议",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "劳动仲裁",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "律师费：¥20,000",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "本地文件：`/contract-drafts/委托代理合同（张三vs相关单位）.docx`",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "打开合同台账"
          },
          "type": "primary",
          "width": "default",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right-bold_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "合同起草完成"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "耗时 32s"
          },
          "color": "green"
        }
      ],
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "feed-read_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "已授权": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**授权成功，已执行：**",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "```\nnpm run build\n```",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "已授权"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "yes_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "拒绝授权": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**拒绝执行：**",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "```\nnpm run build\n```",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "已拒绝"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "grey",
      "icon": {
        "tag": "standard_icon",
        "token": "yes_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "权限请求": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**OpenCode 想执行：**",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "```\nnpm run build\n```",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "允许一次"
                  },
                  "type": "primary",
                  "width": "default",
                  "size": "medium",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "始终允许"
                  },
                  "type": "default",
                  "width": "default",
                  "size": "medium",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "拒绝"
                  },
                  "type": "danger",
                  "width": "default",
                  "size": "medium",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top"
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "权限请求"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": "120s 后自动拒绝"
      },
      "template": "yellow",
      "icon": {
        "tag": "standard_icon",
        "token": "lock_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "材料分析完成": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "案件：**张三违法解除劳动合同争议**",
                  "text_align": "left",
                  "text_size": "heading"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "trisect",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "材料 5",
                  "text_align": "center",
                  "text_size": "heading"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "证据 12",
                  "text_align": "center",
                  "text_size": "heading"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "焦点 4",
                  "text_align": "center",
                  "text_size": "heading"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "chart",
                  "chart_spec": {
                    "type": "pie",
                    "title": {
                      "text": "标签占比"
                    },
                    "data": {
                      "values": [
                        {
                          "tag": "劳动",
                          "value": 32
                        },
                        {
                          "tag": "合同",
                          "value": 10
                        },
                        {
                          "tag": "诉讼程序",
                          "value": 5
                        }
                      ]
                    },
                    "seriesField": "tag",
                    "angleField": "value",
                    "label": {
                      "visible": true,
                      "formatter": "{tag} {value}"
                    },
                    "legends": {
                      "visible": true,
                      "orient": "bottom"
                    }
                  },
                  "preview": true,
                  "color_theme": "converse",
                  "height": "auto",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "材料分析完成"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "耗时 2m 5s"
          },
          "color": "green"
        }
      ],
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "feed-read_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "材料分析进行中": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "markdown",
          "content": "当前处理",
          "text_align": "left",
          "text_size": "normal",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "blue-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**解除通知.pdf**",
                  "text_align": "left",
                  "text_size": "normal",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "读取内容：已完成",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "提取关键信息：进行中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "default"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "loading_outlined",
                    "color": "blue"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "生成结果：等待中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "排队中",
          "text_align": "left",
          "text_size": "normal",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "社保缴纳记录.pdf",
                  "text_align": "left",
                  "text_size": "normal",
                  "margin": "0px 0px 0px 0px",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  }
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "div",
          "text": {
            "tag": "plain_text",
            "content": "已完成",
            "text_size": "normal_v2",
            "text_align": "left",
            "text_color": "default"
          },
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "劳动合同.pdf",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "耗时 1m",
                    "text_size": "notation",
                    "text_align": "center",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "div",
          "text": {
            "tag": "plain_text",
            "content": "生成内容仅供参考，不构成法律意见",
            "text_size": "notation",
            "text_align": "left",
            "text_color": "grey"
          },
          "icon": {
            "tag": "standard_icon",
            "token": "spam_outlined",
            "color": "light_grey"
          }
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "材料分析进行中"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "已解析 3/5"
          },
          "color": "indigo"
        }
      ],
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "材料收集中": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "markdown",
          "content": "请上传劳动相关材料，直接发送到聊天窗口即可。",
          "text_align": "left",
          "text_size": "heading",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**支持格式** ：PDF / DOCX / TXT / MD\n**模式** ：批量导入",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "发送 `/材料收集完成` 结束本次任务",
          "text_align": "left",
          "text_size": "notation",
          "margin": "0px 0px 0px 0px",
          "icon": {
            "tag": "standard_icon",
            "token": "warning_outlined",
            "color": "grey"
          }
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "材料收集中"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "案件信息录入中": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "padding": "12px 12px 12px 12px",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "flow",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "委托人：张三",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "对方当事人：某科技公司",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "案由：劳动争议",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "程序阶段：劳动仲裁",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "flow",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "案号：xxx",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "审理法院：xx法院",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "提取字段：进行中...",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "default"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "loading_outlined",
                    "color": "blue"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "提取字段：已完成",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "写入案件管理表：等待中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "案件信息录入中"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "案件工作台开启": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "请选择你需要分析的领域",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "select_static",
                  "placeholder": {
                    "tag": "plain_text",
                    "content": "请选择"
                  },
                  "options": [
                    {
                      "text": {
                        "tag": "plain_text",
                        "content": "劳动法"
                      },
                      "value": "1",
                      "icon": {
                        "tag": "standard_icon",
                        "token": "signature_outlined"
                      }
                    },
                    {
                      "text": {
                        "tag": "plain_text",
                        "content": "公司法"
                      },
                      "value": "2",
                      "icon": {
                        "tag": "standard_icon",
                        "token": "signature_outlined"
                      }
                    }
                  ],
                  "type": "default",
                  "width": "fill",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "点击开始收集材料"
                  },
                  "type": "primary",
                  "width": "fill",
                  "size": "medium",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "done_outlined"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "button",
                  "text": {
                    "tag": "plain_text",
                    "content": "取消"
                  },
                  "type": "danger",
                  "width": "fill",
                  "size": "medium",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "close-bold_outlined"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_align": "top"
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "案件工作台已开启"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "file-link-word_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "案件已录入": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "padding": "12px 12px 12px 12px",
      "elements": [
        {
          "tag": "markdown",
          "content": "**张三 vs 某科技公司**",
          "text_align": "left",
          "text_size": "heading",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "flow",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "background_style": "purple-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "劳动争议",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "purple-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "仲裁阶段",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "4px 4px 4px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "打开案件管理表"
          },
          "type": "primary",
          "width": "default",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right-bold_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "案件已录入"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "耗时 32s"
          },
          "color": "green"
        }
      ],
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "feed-read_outlined"
      },
      "padding": "12px 12px 12px 12px"
    }
  },
  "法律咨询-无结果": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "未找到与“xxx”直接相关的知识库条目",
                  "text_align": "left",
                  "text_size": "normal_v2"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "法律咨询"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "grey",
      "icon": {
        "tag": "standard_icon",
        "token": "efficiency_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "法律咨询": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "问题",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "\n违法解除劳动合同如何主张赔偿？",
                  "text_align": "left",
                  "text_size": "normal_v2"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "column_set",
                  "horizontal_spacing": "8px",
                  "horizontal_align": "left",
                  "columns": [
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "blue-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "答案 1",
                          "text_align": "left",
                          "text_size": "notation",
                          "margin": "0px 0px 0px 0px"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    }
                  ],
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "column_set",
                  "horizontal_spacing": "8px",
                  "horizontal_align": "left",
                  "columns": [
                    {
                      "tag": "column",
                      "width": "weighted",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、",
                          "text_align": "left",
                          "text_size": "normal_v2",
                          "margin": "0px 0px 0px 0px"
                        }
                      ],
                      "padding": "0px 0px 0px 0px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "12px 0px 12px 0px",
                      "weight": 1
                    }
                  ],
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "> 来源：[劳动合同法问答.pdf · 违法解除]()\n> 法条：[劳动合同法第四十八条]()",
                  "text_align": "left",
                  "text_size": "notation",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "column_set",
                  "horizontal_spacing": "8px",
                  "horizontal_align": "left",
                  "columns": [
                    {
                      "tag": "column",
                      "width": "auto",
                      "background_style": "blue-50",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "答案 2",
                          "text_align": "left",
                          "text_size": "notation",
                          "margin": "0px 0px 0px 0px"
                        }
                      ],
                      "padding": "4px 8px 4px 8px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "0px 0px 0px 0px"
                    }
                  ],
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "column_set",
                  "horizontal_spacing": "8px",
                  "horizontal_align": "left",
                  "columns": [
                    {
                      "tag": "column",
                      "width": "weighted",
                      "elements": [
                        {
                          "tag": "markdown",
                          "content": "可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、可围绕解除理由、程序、和工会程序审查违法性、",
                          "text_align": "left",
                          "text_size": "normal_v2",
                          "margin": "0px 0px 0px 0px"
                        }
                      ],
                      "padding": "0px 0px 0px 0px",
                      "direction": "vertical",
                      "horizontal_spacing": "8px",
                      "vertical_spacing": "8px",
                      "horizontal_align": "left",
                      "vertical_align": "top",
                      "margin": "12px 0px 12px 0px",
                      "weight": 1
                    }
                  ],
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "> 来源：[劳动合同法问答.pdf · 违法解除]()\n> 法条：[劳动合同法第四十八条]()",
                  "text_align": "left",
                  "text_size": "notation",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "查看知识库"
          },
          "type": "primary",
          "width": "fill",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right-bold_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "法律咨询"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "2 条答案"
          },
          "color": "purple"
        }
      ],
      "template": "indigo",
      "icon": {
        "tag": "standard_icon",
        "token": "efficiency_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "知识入库失败": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "文件：**经济补偿计算规则.docx**",
                  "text_align": "left",
                  "text_size": "heading"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "red-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**原因**：PDF 解析失败",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "markdown",
                  "content": "**建议**：请检查文件是否损坏或重新上传",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "重新上传"
          },
          "type": "primary",
          "width": "fill",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "入库失败"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "red",
      "icon": {
        "tag": "standard_icon",
        "token": "more-close_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "知识入库完成": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "trisect",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "提取 47",
                  "text_align": "center",
                  "text_size": "heading"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "去重 22",
                  "text_align": "center",
                  "text_size": "heading"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "入库 63",
                  "text_align": "center",
                  "text_size": "heading"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "chart",
                  "chart_spec": {
                    "type": "pie",
                    "title": {
                      "text": "标签占比"
                    },
                    "data": {
                      "values": [
                        {
                          "tag": "劳动",
                          "value": 32
                        },
                        {
                          "tag": "合同",
                          "value": 10
                        },
                        {
                          "tag": "诉讼程序",
                          "value": 5
                        }
                      ]
                    },
                    "seriesField": "tag",
                    "angleField": "value",
                    "label": {
                      "visible": true,
                      "formatter": "{tag} {value}"
                    },
                    "legends": {
                      "visible": true,
                      "orient": "bottom"
                    }
                  },
                  "preview": true,
                  "color_theme": "converse",
                  "height": "auto",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**经济补偿计算规则.docx**",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  }
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "提取 13",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 4px 0px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "去重 2",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 4px 0px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "入库 2",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 4px 0px 4px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "损坏文件.docx",
                  "text_align": "left",
                  "text_size": "normal_v2",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "more-close_outlined",
                    "color": "red"
                  }
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "解析失败",
                    "text_size": "notation",
                    "text_align": "left",
                    "text_color": "red"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "button",
          "text": {
            "tag": "plain_text",
            "content": "查看知识库"
          },
          "type": "primary",
          "width": "fill",
          "size": "medium",
          "icon": {
            "tag": "standard_icon",
            "token": "right-bold_outlined"
          },
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "知识入库完成"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "耗时 34s"
          },
          "color": "green"
        }
      ],
      "template": "green",
      "icon": {
        "tag": "standard_icon",
        "token": "feed-read_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "知识入库已开启": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "blue-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**支持格式** ：PDF ▪ DOCX ▪ TXT ▪ MD\n**模式** ：批量入库",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "发送文件或 URL 即可入库\n",
          "text_align": "left",
          "text_size": "normal"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": ">发送 `/知识入库结束` 结束本次任务",
          "text_align": "left",
          "text_size": "notation",
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "知识入库已开启"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "status-vacation_filled"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "知识入库排队中": {
    "schema": "2.0",
    "config": {
      "update_multi": true
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "排队文件：**经济补偿计算规则.docx**",
                  "text_align": "left",
                  "text_size": "heading"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "12px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "grey-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**前方队列**：2 个素材",
                  "text_align": "left",
                  "text_size": "normal"
                },
                {
                  "tag": "markdown",
                  "content": "**预计开始**：前序处理完成后自动执行",
                  "text_align": "left",
                  "text_size": "normal"
                }
              ],
              "padding": "12px 12px 12px 12px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "4px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "> 发送 /知识入库结束 提前结束入库",
                  "text_align": "left",
                  "text_size": "notation"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "知识入库排队中"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "template": "orange",
      "icon": {
        "tag": "standard_icon",
        "token": "time_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  },
  "知识入库进行中": {
    "schema": "2.0",
    "config": {
      "update_multi": true,
      "style": {
        "text_size": {
          "normal_v2": {
            "default": "normal",
            "pc": "normal",
            "mobile": "heading"
          }
        }
      }
    },
    "body": {
      "direction": "vertical",
      "horizontal_spacing": "8px",
      "vertical_spacing": "8px",
      "horizontal_align": "left",
      "vertical_align": "top",
      "elements": [
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "green-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "已完成  1",
                  "text_align": "center",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "wathet-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "处理中 1",
                  "text_align": "center",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "yellow-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "排队中 1",
                  "text_align": "center",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            },
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "red-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "失败 1",
                  "text_align": "center",
                  "text_size": "normal_v2",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "background_style": "blue-50",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "**解除通知.pdf**",
                  "text_align": "left",
                  "text_size": "normal",
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "读取内容：已完成",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "提取关键信息：进行中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "default"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "loading_outlined",
                    "color": "blue"
                  },
                  "margin": "0px 0px 0px 0px"
                },
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "生成结果：等待中",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "grey"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "8px 8px 8px 8px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "markdown",
          "content": "排队中",
          "text_align": "left",
          "text_size": "normal",
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "weighted",
              "elements": [
                {
                  "tag": "markdown",
                  "content": "社保缴纳记录.pdf",
                  "text_align": "left",
                  "text_size": "normal",
                  "margin": "0px 0px 0px 0px",
                  "icon": {
                    "tag": "standard_icon",
                    "token": "ellipse_outlined",
                    "color": "grey"
                  }
                },
                {
                  "tag": "hr",
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top",
              "margin": "0px 0px 0px 0px",
              "weight": 1
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "div",
          "text": {
            "tag": "plain_text",
            "content": "已完成",
            "text_size": "normal_v2",
            "text_align": "left",
            "text_color": "default"
          },
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "background_style": "green-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "劳动合同.pdf",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "green"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "yes_outlined",
                    "color": "green"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "入库 18 条",
                    "text_size": "notation",
                    "text_align": "center",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "耗时 1m",
                    "text_size": "notation",
                    "text_align": "center",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "column_set",
          "flex_mode": "stretch",
          "background_style": "red-50",
          "horizontal_spacing": "8px",
          "horizontal_align": "left",
          "columns": [
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "劳动合同.pdf",
                    "text_size": "normal_v2",
                    "text_align": "left",
                    "text_color": "red"
                  },
                  "icon": {
                    "tag": "standard_icon",
                    "token": "more-close_outlined",
                    "color": "red"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "vertical_spacing": "8px",
              "horizontal_align": "left",
              "vertical_align": "top"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "解析",
                    "text_size": "notation",
                    "text_align": "center",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            },
            {
              "tag": "column",
              "width": "auto",
              "elements": [
                {
                  "tag": "div",
                  "text": {
                    "tag": "plain_text",
                    "content": "耗时 1m",
                    "text_size": "notation",
                    "text_align": "center",
                    "text_color": "grey"
                  },
                  "margin": "0px 0px 0px 0px"
                }
              ],
              "padding": "0px 0px 0px 0px",
              "direction": "vertical",
              "horizontal_spacing": "8px",
              "vertical_spacing": "8px",
              "horizontal_align": "center",
              "vertical_align": "center",
              "margin": "0px 0px 0px 0px"
            }
          ],
          "margin": "0px 0px 0px 0px"
        },
        {
          "tag": "hr",
          "margin": "0px 0px 0px 0px"
        }
      ]
    },
    "header": {
      "title": {
        "tag": "plain_text",
        "content": "知识入库进行中"
      },
      "subtitle": {
        "tag": "plain_text",
        "content": ""
      },
      "text_tag_list": [
        {
          "tag": "text_tag",
          "text": {
            "tag": "plain_text",
            "content": "已解析 3/5"
          },
          "color": "indigo"
        }
      ],
      "template": "blue",
      "icon": {
        "tag": "standard_icon",
        "token": "loading_outlined"
      },
      "padding": "12px 8px 12px 12px"
    }
  }
} as const;

export type DesignerCardTemplateName = keyof typeof DESIGNER_CARD_TEMPLATES;
