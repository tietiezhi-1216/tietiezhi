package hook

import "context"

// HookPoint Hook 触发点
type HookPoint string

const (
	BeforeLLMCall  HookPoint = "before_llm_call"  // LLM 调用前
	AfterLLMCall   HookPoint = "after_llm_call"   // LLM 调用后
	BeforeToolCall HookPoint = "before_tool_call" // 工具调用前
	AfterToolCall  HookPoint = "after_tool_call"  // 工具调用后
	BeforeSend     HookPoint = "before_send"      // 发送消息前
	AfterReceive   HookPoint = "after_receive"    // 接收消息后
)

// Hook Hook 接口
type Hook interface {
	// Name Hook 名称
	Name() string
	// Point 触发点
	Point() HookPoint
	// Execute 执行 Hook 逻辑
	Execute(ctx context.Context, data any) (any, error)
}

// Chain Hook 执行链
type Chain struct {
	hooks map[HookPoint][]Hook
}

// NewChain 创建 Hook 执行链
func NewChain() *Chain {
	return &Chain{
		hooks: make(map[HookPoint][]Hook),
	}
}

// Register 注册 Hook
func (c *Chain) Register(h Hook) {
	c.hooks[h.Point()] = append(c.hooks[h.Point()], h)
}

// Execute 执行指定触发点的所有 Hook
func (c *Chain) Execute(ctx context.Context, point HookPoint, data any) (any, error) {
	hooks, ok := c.hooks[point]
	if !ok {
		return data, nil
	}
	result := data
	for _, h := range hooks {
		var err error
		result, err = h.Execute(ctx, result)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}
