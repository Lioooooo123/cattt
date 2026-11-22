import type { destinationIds } from "../world/protocol.ts";

export type YardDestination = typeof destinationIds[number];
export type YardIntent = { kind: "state" | "action_status" | "sit" } | { kind: "move"; destination: YardDestination };

export const yardNames: Record<YardDestination, string> = {
  house: "蘑菇屋", tree: "树屋", bed: "猫窝", grass: "草丛", pond: "池塘", fence: "栅栏边",
};

const destinations: Record<string, YardDestination> = {
  蘑菇屋: "house", 蘑菇屋门口: "house", 树屋: "tree", 树窝: "tree", 树下: "tree",
  猫窝: "bed", 草丛: "grass", 草地: "grass", 池塘: "pond", 池塘边: "pond", 水边: "pond",
  栅栏: "fence", 栅栏边: "fence",
};
const move = new RegExp(`^(?:请|麻烦|拜托|我想让)?(?:你)?(?:可以|能不能|能|要不要|帮我)?(?:去|走到|走去|跑到|挪到|移动到|到|回|回到)(${Object.keys(destinations).join("|")})(?:那边|看看|待一会儿|一下)?(?:可以吗|好吗|行吗|好不好|吧|呀|吗)?$`);

export function yardChatIntent(text: string): YardIntent | undefined {
  const request = text.trim().replace(/^(?:@?团子|猫猫)[，,：:、\s]*/, "").replace(/[。！？!?～~]+$/, "");
  const place = move.exec(request)?.[1];
  if (place) return { kind: "move", destination: destinations[place]! };
  if (/^(?:请|麻烦|拜托|我想让)?(?:你)?(?:可以|能不能|能|要不要|帮我)?(?:过来)?(?:陪我坐|陪我一起坐|和我一起坐|一起坐|陪坐)(?:一下|一会儿?|一会儿吧|片刻|下|坐)?(?:好吗|可以吗|好不好|吧|呀|吗)?$/.test(request)) {
    return { kind: "sit" };
  }
  if (/^(?:你)?(?:现在|刚才)?(?:到(?:了|地方了|目的地了)|坐稳了|坐下了)(?:吗|没|没有)$/.test(request)) {
    return { kind: "action_status" };
  }
  if (/^(?:你)?(?:现在)?(?:(?:在哪(?:儿|里)?|在做什么|在干(?:什么|嘛)|在哪个位置)(?:呢|呀|吗)?|(?:的)?(?:院子|小院)状态|(?:查一下|看看)(?:院子|小院)(?:的)?状态)$/.test(request)) {
    return { kind: "state" };
  }
}
