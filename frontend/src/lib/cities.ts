// 内嵌中国主要城市列表，用于天气动态内容城市选择器。
// locationId 传给 QWeather。直辖市用稳定 location id，其余城市用中文名交给 QWeather 解析。

export interface City {
  name: string;
  province: string;
  locationId: string;
}

export const CITIES: City[] = [
  // ── 直辖市 ──────────────────────────────────────────────────
  { name: '北京', province: '北京', locationId: '北京' },
  { name: '天津', province: '天津', locationId: '101030100' },
  { name: '上海', province: '上海', locationId: '101020100' },
  { name: '重庆', province: '重庆', locationId: '101040100' },

  // ── 东北 ──────────────────────────────────────────────────
  { name: '哈尔滨', province: '黑龙江', locationId: '哈尔滨' },
  { name: '大庆', province: '黑龙江', locationId: '大庆' },
  { name: '齐齐哈尔', province: '黑龙江', locationId: '齐齐哈尔' },
  { name: '牡丹江', province: '黑龙江', locationId: '牡丹江' },
  { name: '长春', province: '吉林', locationId: '长春' },
  { name: '吉林市', province: '吉林', locationId: '吉林市' },
  { name: '沈阳', province: '辽宁', locationId: '沈阳' },
  { name: '大连', province: '辽宁', locationId: '大连' },
  { name: '鞍山', province: '辽宁', locationId: '鞍山' },

  // ── 华北 ──────────────────────────────────────────────────
  { name: '呼和浩特', province: '内蒙古', locationId: '呼和浩特' },
  { name: '包头', province: '内蒙古', locationId: '包头' },
  { name: '鄂尔多斯', province: '内蒙古', locationId: '鄂尔多斯' },
  { name: '石家庄', province: '河北', locationId: '石家庄' },
  { name: '唐山', province: '河北', locationId: '唐山' },
  { name: '保定', province: '河北', locationId: '保定' },
  { name: '邯郸', province: '河北', locationId: '邯郸' },
  { name: '太原', province: '山西', locationId: '太原' },
  { name: '大同', province: '山西', locationId: '大同' },

  // ── 西北 ──────────────────────────────────────────────────
  { name: '西安', province: '陕西', locationId: '西安' },
  { name: '咸阳', province: '陕西', locationId: '咸阳' },
  { name: '宝鸡', province: '陕西', locationId: '宝鸡' },
  { name: '兰州', province: '甘肃', locationId: '兰州' },
  { name: '银川', province: '宁夏', locationId: '银川' },
  { name: '乌鲁木齐', province: '新疆', locationId: '乌鲁木齐' },
  { name: '西宁', province: '青海', locationId: '西宁' },
  { name: '拉萨', province: '西藏', locationId: '拉萨' },

  // ── 华东 ──────────────────────────────────────────────────
  { name: '济南', province: '山东', locationId: '济南' },
  { name: '青岛', province: '山东', locationId: '青岛' },
  { name: '烟台', province: '山东', locationId: '烟台' },
  { name: '临沂', province: '山东', locationId: '临沂' },
  { name: '淄博', province: '山东', locationId: '淄博' },
  { name: '潍坊', province: '山东', locationId: '潍坊' },
  { name: '济宁', province: '山东', locationId: '济宁' },
  { name: '南京', province: '江苏', locationId: '南京' },
  { name: '苏州', province: '江苏', locationId: '苏州' },
  { name: '无锡', province: '江苏', locationId: '无锡' },
  { name: '南通', province: '江苏', locationId: '南通' },
  { name: '常州', province: '江苏', locationId: '常州' },
  { name: '徐州', province: '江苏', locationId: '徐州' },
  { name: '扬州', province: '江苏', locationId: '扬州' },
  { name: '镇江', province: '江苏', locationId: '镇江' },
  { name: '连云港', province: '江苏', locationId: '连云港' },
  { name: '合肥', province: '安徽', locationId: '合肥' },
  { name: '芜湖', province: '安徽', locationId: '芜湖' },
  { name: '蚌埠', province: '安徽', locationId: '蚌埠' },
  { name: '杭州', province: '浙江', locationId: '杭州' },
  { name: '宁波', province: '浙江', locationId: '宁波' },
  { name: '温州', province: '浙江', locationId: '温州' },
  { name: '绍兴', province: '浙江', locationId: '绍兴' },
  { name: '嘉兴', province: '浙江', locationId: '嘉兴' },
  { name: '金华', province: '浙江', locationId: '金华' },
  { name: '台州', province: '浙江', locationId: '台州' },
  { name: '湖州', province: '浙江', locationId: '湖州' },
  { name: '福州', province: '福建', locationId: '福州' },
  { name: '厦门', province: '福建', locationId: '厦门' },
  { name: '泉州', province: '福建', locationId: '泉州' },
  { name: '南昌', province: '江西', locationId: '南昌' },
  { name: '赣州', province: '江西', locationId: '赣州' },

  // ── 华中 ──────────────────────────────────────────────────
  { name: '郑州', province: '河南', locationId: '郑州' },
  { name: '洛阳', province: '河南', locationId: '洛阳' },
  { name: '开封', province: '河南', locationId: '开封' },
  { name: '新乡', province: '河南', locationId: '新乡' },
  { name: '武汉', province: '湖北', locationId: '武汉' },
  { name: '宜昌', province: '湖北', locationId: '宜昌' },
  { name: '襄阳', province: '湖北', locationId: '襄阳' },
  { name: '长沙', province: '湖南', locationId: '长沙' },
  { name: '株洲', province: '湖南', locationId: '株洲' },
  { name: '岳阳', province: '湖南', locationId: '岳阳' },
  { name: '常德', province: '湖南', locationId: '常德' },

  // ── 华南 ──────────────────────────────────────────────────
  { name: '广州', province: '广东', locationId: '广州' },
  { name: '深圳', province: '广东', locationId: '深圳' },
  { name: '珠海', province: '广东', locationId: '珠海' },
  { name: '佛山', province: '广东', locationId: '佛山' },
  { name: '东莞', province: '广东', locationId: '东莞' },
  { name: '中山', province: '广东', locationId: '中山' },
  { name: '汕头', province: '广东', locationId: '汕头' },
  { name: '湛江', province: '广东', locationId: '湛江' },
  { name: '惠州', province: '广东', locationId: '惠州' },
  { name: '南宁', province: '广西', locationId: '南宁' },
  { name: '柳州', province: '广西', locationId: '柳州' },
  { name: '海口', province: '海南', locationId: '海口' },
  { name: '三亚', province: '海南', locationId: '三亚' },

  // ── 西南 ──────────────────────────────────────────────────
  { name: '成都', province: '四川', locationId: '成都' },
  { name: '绵阳', province: '四川', locationId: '绵阳' },
  { name: '贵阳', province: '贵州', locationId: '贵阳' },
  { name: '昆明', province: '云南', locationId: '昆明' },
];

/** 按城市名或省份名模糊匹配，返回匹配项（不限制数量，调用方自行 slice）。 */
export function searchCities(query: string): City[] {
  const q = query.trim();
  if (!q) return [];
  return CITIES.filter((c) => c.name.includes(q) || c.province.includes(q));
}
