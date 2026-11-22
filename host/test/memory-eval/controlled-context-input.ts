// Frozen stand-in for the extractor. The score labels live in corpus.ts.
export type Candidate = readonly [
  messageId: string, subject: "a" | "b" | "pair", predicate: string, value: string, replacesMessageId?: string,
];

export const controlledCandidates: Readonly<Record<string, readonly Candidate[]>> = {
  "same-preference": [
    ["m1", "a", "咖啡口味", "热美式"],
    ["m2", "b", "咖啡口味", "热美式"],
  ],
  "opposite-and-correction": [
    ["m1", "a", "奶茶甜度", "加糖"],
    ["m2", "b", "奶茶甜度", "无糖"],
    ["m3", "a", "奶茶甜度", "三分糖", "m1"],
  ],
  "different-source-and-subject": [
    ["m1", "b", "茶口味", "普洱"],
    ["m2", "a", "茶口味", "茉莉花茶"],
  ],
  "joint-preference": [["m1", "pair", "周末共用早餐", "豆浆油条"]],
  "pronouns": [["m2", "b", "周末运动", "骑车"]],
  "unknown-source": [["m2", "b", "茶口味", "乌龙"]],
  "assistant-plan": [],
  "withdrawal": [
    ["m1", "b", "早饭点心", "桂花糕"],
    ["m2", "b", "早饭饮品", "无糖豆浆"],
  ],
  "count-budget": [
    ["old-1", "a", "以前路上买的咖啡", "车站热咖啡"],
    ["old-2", "b", "以前聚会点的咖啡", "咖啡店冷萃"],
    ["old-3", "a", "以前试喝的咖啡", "展馆的燕麦拿铁"],
    ["old-4", "b", "以前收藏的咖啡单", "机场咖啡店菜单"],
    ["a-1", "a", "咖啡杯型", "小杯"],
    ["b-1", "b", "咖啡杯型", "大杯"],
    ["a-2", "a", "咖啡温度", "热的"],
    ["b-2", "b", "咖啡温度", "冰的"],
    ["a-3", "a", "咖啡甜度", "不加糖"],
    ["b-3", "b", "咖啡甜度", "加一泵糖浆"],
    ["a-4", "a", "咖啡奶种", "燕麦奶"],
    ["b-4", "b", "咖啡奶种", "全脂奶"],
  ],
  "character-budget": [
    ["old-1", "a", "旧咖啡菜单甲", "这家店从前提供不同风味的咖啡，菜单上有拿铁、美式和手冲，也有浅烘豆、深烘豆和当季拼配可选。".repeat(29)],
    ["old-2", "b", "旧咖啡菜单乙", "旧菜单的咖啡记录还有小杯、大杯、双份浓缩和多种牛奶，店员会另写糖浆种类和冰量备注。".repeat(32)],
    ["a-1", "a", "咖啡甜度", "不加糖"],
    ["b-1", "b", "咖啡甜度", "加一泵糖浆"],
  ],
};
