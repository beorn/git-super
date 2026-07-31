import React from "react"
import { Box, H2, Muted, Text, renderStatic } from "silvery"
import type { ConsultedRepository } from "./diff.ts"

export type ReportRenderOptions = Readonly<{
  width?: number
  plain?: boolean
}>

export function ConsultedRepositoriesReport({
  repositories,
}: Readonly<{ repositories: readonly ConsultedRepository[] }>): React.ReactElement {
  return (
    <Box flexDirection="column" gap={1}>
      <H2>Consulted repositories</H2>
      <Box flexDirection="column">
        {repositories.map((repository) => (
          <Box key={repository.path} flexDirection="row" gap={2}>
            <Text color="$fg-success">✓</Text>
            <Text>{repository.path}</Text>
            {repository.from && repository.to ? (
              <Muted>
                {repository.from.slice(0, 12)} → {repository.to.slice(0, 12)}
              </Muted>
            ) : null}
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export function renderConsultedRepositories(
  repositories: readonly ConsultedRepository[],
  options: ReportRenderOptions = {},
): Promise<string> {
  return renderStatic(<ConsultedRepositoriesReport repositories={repositories} />, options)
}
