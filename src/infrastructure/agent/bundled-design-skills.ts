import type { SkillRecord } from "../../application/design-resource-contract";

export const BUNDLED_DESIGN_SKILLS: ReadonlyArray<Pick<SkillRecord, "name" | "digest" | "files">> = [
  {
    name: "apple-design",
    digest: "d9fb1d916585938c5319b431c1328e848bcff9d94b8444eb1d55367dee509f70",
    files: { "SKILL.md": "77bb63b7043bb93aca2ff4ab040c249484eef35682bb6ff7163433c31d30adc7" },
  },
  {
    name: "mobile-native",
    digest: "0392a9cc3d03b94e810f21294b9edffb436b2f9cf3cc2108dab93eb00ce8369f",
    files: { "SKILL.md": "888b7651d66d66dbac4e72b7c554638eb19bd971d686d6cbdf030a5ef3788f55" },
  },
  {
    name: "emil-design-eng",
    digest: "a1acca2db99e3ebeaa38a855923b8289d765be564158fa0e0c39dd4ced52d701",
    files: { "SKILL.md": "ffbe68e6007fb42cb8149f089b400a1ca007d59ba23e8948e2be4476f3175939" },
  },
  {
    name: "prototype",
    digest: "1a58326216ee44e8bbabd58f67e75ab50b2b74d9184139a9d11976ebbb8c30a5",
    files: {
      "PICKER.md": "31a55eec94715cc79942e91e172e539e3031dcd5e2e5ee7c1446cf2caee960a6",
      "SKILL.md": "76b06761f58d44ebdd02e4e4217ecf7eb210a057171431603cd8b201792cf3fc",
    },
  },
];
