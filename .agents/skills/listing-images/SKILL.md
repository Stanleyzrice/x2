---
name: listing-images
description: 审阅同款商品图，按需编辑，经 X2 导入并核对最终图序和规格映射。
---

从 `listing reviewed-images-preview` 读取完整来源和规格图映射，缺来源时先准备单稿。实看主图、详情、尺码表和所选 SKU。台湾站图片中的简体字按流程转台湾繁体，包含短规格标注；经实际审阅的同款无待翻译原图可直接复用。查看 OpenAI Image（图片编辑）的实际输出，核对译文与所选规格。未变文件和范围复用已有看图证据。

按[审图流程](references/reviewed-images.md)提交真实证据。新稿用 `reviewed-images` 导入并续做，已建商品用 `upload-reviewed-assets` 后走[商品修改](../../../skills/listing/references/editing.md)。核对手机端详情可读性、原详情覆盖和最终图序；尺寸表只用已核对的数值和单位。发布按[上架流程](../../../skills/listing/SKILL.md)确认和读回。
