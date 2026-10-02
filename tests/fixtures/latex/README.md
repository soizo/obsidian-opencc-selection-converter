# LaTeX integration fixtures

Executable fixtures live in `tests/cli/latex.test.ts` and run inside Obsidian in both source mode and Live Preview. They obtain real Markdown math-region offsets through the registered editor extension, rather than testing an isolated string parser in Node.

Coverage: direct characters; symbols and Greek variants; all twelve supported text/font commands; fractions, roots and optional indices; grouped/unbraced arguments; subscripts/superscripts; original-selection policies and parent protection; quoted display math; escapes and partial commands; unknown macros/environments, unbalanced groups, duplicate scripts.

Unknown macros are rejected when they can affect selected content, including later arguments whose rendering cannot be inferred. Entire skipped groups do not need their macros interpreted. Nesting is limited to 64. This is a fixed supported subset, not a general TeX interpreter.
