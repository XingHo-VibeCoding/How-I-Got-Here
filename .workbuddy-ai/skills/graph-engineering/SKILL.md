---
name: graph-engineering
description: 用「任务图（task graph）」的方式执行复杂任务——把目标拆成边界清晰的节点，只对有真实依赖的节点串行、独立节点并行，节点间用结构化输出传递，关键结论加独立验证者，失败走有上限的反馈回路，最后由主智能体合并校验后再交付。当任务复杂、多步骤、可并行，尤其是写代码 / 改代码 / 多文件改动 / 重构 / 调试 / 需要交叉验证结论时使用。
agent_created: true
---

# Graph Engineering（任务图执行法）

把复杂任务变成一张「最简、最可靠、最省」的任务图，而不是一口气硬做。

## 适用场景

- 任务包含多个互相独立、可以并行推进的子任务
- 任务包含需要交叉验证的关键结论（事实、数字、日期、对外口径）
- 写代码、改代码、多文件改动、重构、调试等「牵一发动全身」的场景
- 判断口径：**简单任务直接做；只有建图能带来真实收益时才建图**

## 使用方式

1. 先按复杂度与风险选执行路径（见 `routing`）。
2. 决定建图后，为每个节点写清节点契约（见 `node_contract`）。
3. 执行节点的产出必须经过验证才允许往下传（见 `verification`）。
4. 验证不通过时走有上限的反馈回路，绝不做无界循环（见 `feedback_loop`）。
5. 主智能体对整张图和最终结果负责，只交付合并并校验过的结果（见 `finalization`）。

---

## 原则正文

please use 2-10 subagents for the complex tasks

You should operating according to Graph Engineering principles. Your goal is to complete the user's objective with the simplest, most reliable, and cost-efficient task graph.

### graph_design

1. Define the final objective and acceptance criteria.
2. Decompose complex work into clear, bounded nodes.
3. Create edges only for real dependencies:
   - Execute nodes sequentially when one requires another's output.
   - Execute independent nodes in parallel.
4. Complete simple tasks directly. Do not create a graph unless it adds real value.

### node_contract

Every node must define:

- Task: What must be completed
- Input: What data it may use
- Output: What fields it must return
- Constraints: What it may and may not do
- Acceptance criteria: How success is determined

Use structured outputs. A node must not pass its result downstream if required fields are missing or validation fails.

### parallel_execution

Use fan-out when multiple tasks are independent.

After all required branches finish, use fan-in to:

1. Validate output formats
2. Remove duplicates
3. Identify conflicting conclusions
4. Preserve sources and evidence
5. Produce one normalized result

Never make independent nodes wait for one another.

### routing

Select the execution path according to complexity and risk:

- Simple, low-risk task: execute directly
- Independent subtasks: execute in parallel
- Important facts or high-risk conclusions: add an independent verifier
- Conflicting or insufficient evidence: return the work to the responsible node
- Concurrent changes to the same resource: isolate workspaces or execute sequentially

### verification

Do not accept execution-node output without verification.

The verifier must check:

- Whether the user's objective was satisfied
- Whether evidence and sources are reliable
- Whether dates, numbers, and critical facts are consistent
- Whether outputs from different nodes conflict
- Whether the required schema was followed
- Whether important information is missing

A verifier identifies defects; it must not conceal them.

### feedback_loop

When verification fails, send specific feedback to the responsible node and run it again.

Every loop must include:

- A clear failure reason
- A specific correction request
- Verification of the revised result
- A maximum retry count

Stop when any condition is met:

- Verification passes
- Two consecutive reviews find no new material issue
- The maximum retry count is reached
- Required user information or permission is unavailable

Never create an unbounded loop.

### cost_control

Parallel execution reduces latency, not total resource usage.

Therefore:

- Create only necessary nodes
- Use lower-cost capabilities for extraction, classification, and formatting
- Use stronger capabilities for conflict resolution, verification, and final decisions
- Use deterministic code for waiting, deduplication, sorting, and transformation
- Create a new node only when its expected value exceeds its coordination cost

### finalization

The primary agent owns the complete graph and the final result. Never deliver unchecked node output directly to the user.

Before delivery, confirm that:

1. Every required node has completed
2. All dependencies have been satisfied
3. Parallel outputs have been merged correctly
4. Important conclusions have been independently verified
5. Every loop has terminated correctly
6. The final result satisfies the acceptance criteria

Deliver only the merged and verified result. Briefly state the verification status and any remaining risks.
