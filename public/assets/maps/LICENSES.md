# 地图数据来源与许可

统计页中的地图文件全部随站点本地提供，页面运行时不会从第三方 CDN 请求地图数据。

## 世界国家边界

- 文件：`world-countries-110m.json`
- 项目：[world-atlas](https://github.com/topojson/world-atlas)
- 数据基础：[Natural Earth](https://www.naturalearthdata.com/) 1:110m 国家边界
- 获取版本：`world-atlas@2.0.2` 的 `countries-110m.json`
- world-atlas 版权：Copyright 2013-2019 Michael Bostock
- 许可：ISC License。Natural Earth 数据为公共领域数据。

ISC License：

> Permission to use, copy, modify, and/or distribute this software for any purpose
> with or without fee is hereby granted, provided that the above copyright notice
> and this permission notice appear in all copies.
>
> THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
> REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
> FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
> INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
> OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
> TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
> THIS SOFTWARE.

## 中国省级边界

- 文件：`china-adm1.geojson`
- 元数据：`china-adm1-metadata.json`
- 项目：[geoBoundaries](https://www.geoboundaries.org/)
- 数据集：CHN ADM1 simplified，34 个省级区域
- 固定版本：仓库修订 `9469f09`，数据集构建日期 2023-12-12
- 边界来源：geoBoundaries、Wikimedia Commons
- 数据集许可：Public Domain（见随附元数据中的 `boundaryLicense`）
- 修改说明：本站未改动边界坐标，仅在浏览器内为区域附加 ISO 3166-2 省级代码，以便与匿名统计结果匹配。

边界仅用于汇总数据可视化，不代表项目对任何行政边界或领土主张的立场。
