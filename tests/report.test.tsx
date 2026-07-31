import { expect, test } from "bun:test"
import { renderConsultedRepositories } from "../src/report.tsx"

test("renders a structured consulted-repositories witness with Silvery", async () => {
  const output = await renderConsultedRepositories(
    [
      { path: ".", root: "/tmp/product" },
      { path: "vendor/alpha", root: "/tmp/product/vendor/alpha", from: "a".repeat(40), to: "b".repeat(40) },
    ],
    { plain: true, width: 100 },
  )

  expect(output).toContain("Consulted repositories")
  expect(output).toContain("✓  .")
  expect(output).toContain("✓  vendor/alpha")
  expect(output).toContain("aaaaaaaaaaaa → bbbbbbbbbbbb")
})
