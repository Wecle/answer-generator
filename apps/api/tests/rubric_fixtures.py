def valid_candidate_data() -> dict:
    return {
        "version": "v2",
        "role_prompt": "你是一名结构化面试考生。",
        "source_requirements": [
            {"id": "REQ-001", "text": "准确分析问题", "kind": "criterion"},
            {"id": "REQ-002", "text": "措施形成闭环", "kind": "criterion"},
        ],
        "global_constraints": [],
        "dimensions": [
            {
                "id": "DIM-001",
                "name": "综合分析",
                "max_score": 50,
                "source_requirement_ids": ["REQ-001"],
                "criteria": [
                    {
                        "id": "CRI-001",
                        "text": "准确分析问题",
                        "source_requirement_ids": ["REQ-001"],
                    }
                ],
                "pitfalls": [
                    {
                        "id": "PIT-001",
                        "text": "只表态不分析",
                        "source_requirement_ids": ["REQ-001"],
                    }
                ],
            },
            {
                "id": "DIM-002",
                "name": "解决问题",
                "max_score": 50,
                "source_requirement_ids": ["REQ-002"],
                "criteria": [
                    {
                        "id": "CRI-002",
                        "text": "措施形成闭环",
                        "source_requirement_ids": ["REQ-002"],
                    }
                ],
                "pitfalls": [
                    {
                        "id": "PIT-002",
                        "text": "措施没有反馈",
                        "source_requirement_ids": ["REQ-002"],
                    }
                ],
            },
        ],
        "answer_principles": ["围绕题目作答"],
        "retry_policy": ["定向修复低分项"],
        "output_rules": ["输出纯文本"],
        "inferred_scores": False,
    }


def valid_schema_data() -> dict:
    candidate = valid_candidate_data()
    inferred_scores = candidate.pop("inferred_scores")
    return {
        **candidate,
        "compilation": {
            "compiler_model": "test-model",
            "auditor_model": None,
            "coverage_passed": False,
            "inferred_scores": inferred_scores,
        },
    }
