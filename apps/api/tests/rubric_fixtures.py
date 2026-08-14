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


def normalized_candidate_data() -> dict:
    candidate = valid_candidate_data()
    candidate["source_requirements"].extend(
        [
            {"id": "REQ-003", "text": "有画面可加2-4分", "kind": "score"},
            {"id": "REQ-004", "text": "有人味儿可加2-3分", "kind": "score"},
            {"id": "REQ-005", "text": "答非所问掉到60-70分", "kind": "score"},
            {"id": "REQ-006", "text": "超时印象分大扣", "kind": "score"},
        ]
    )
    candidate["dimensions"][0]["max_score"] = 40
    candidate["dimensions"][1]["max_score"] = 35
    candidate["scoring_policy"] = {
        "mode": "normalized_rules",
        "base_max_score": 75,
        "bonus_rules": [
            {
                "id": "BONUS-001",
                "text": "有画面可加2-4分",
                "min_score": 2,
                "max_score": 4,
                "source_requirement_ids": ["REQ-003"],
            },
            {
                "id": "BONUS-002",
                "text": "有人味儿可加2-3分",
                "min_score": 2,
                "max_score": 3,
                "source_requirement_ids": ["REQ-004"],
            },
        ],
        "penalty_rules": [
            {
                "id": "PEN-001",
                "text": "答非所问掉到60-70分",
                "effect": "set_range",
                "min_score": 60,
                "max_score": 70,
                "source_requirement_ids": ["REQ-005"],
            },
            {
                "id": "PEN-002",
                "text": "超时印象分大扣",
                "effect": "qualitative",
                "source_requirement_ids": ["REQ-006"],
            },
        ],
        "score_conflicts": [
            {
                "text": "档位标题与逐项上限不一致",
                "source_requirement_ids": ["REQ-003", "REQ-004"],
            }
        ],
        "normalization": {
            "raw_max_score": 82,
            "target_max_score": 100,
            "method": "linear",
        },
    }
    return candidate


def normalized_schema_data() -> dict:
    candidate = normalized_candidate_data()
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


def reported_normalized_candidate_data() -> dict:
    """Represent the reported 75-base, 22-bonus scoring source exactly."""
    candidate = valid_candidate_data()
    candidate["source_requirements"].extend(
        [
            {
                "id": f"REQ-{index:03d}",
                "text": text,
                "kind": "score",
            }
            for index, text in enumerate(
                [
                    "有画面可加2-4分",
                    "有细节可加2-3分",
                    "有人味儿可加1-3分",
                    "有金句可加1-3分",
                    "有结构可加1-3分",
                    "有深度可加1-3分",
                    "有共情可加1-3分",
                    "答非所问直接掉到60-70分",
                    "超时印象分大扣",
                    "档位标题最高分为90分",
                    "基础分与逐项加分上限合计为97分",
                ],
                start=3,
            )
        ]
    )
    candidate["dimensions"][0]["max_score"] = 40
    candidate["dimensions"][1]["max_score"] = 35
    bonus_ranges = [(2, 4), (2, 3), (1, 3), (1, 3), (1, 3), (1, 3), (1, 3)]
    candidate["scoring_policy"] = {
        "mode": "normalized_rules",
        "base_max_score": 75,
        "bonus_rules": [
            {
                "id": f"BONUS-{index:03d}",
                "text": candidate["source_requirements"][index + 1]["text"],
                "min_score": score_range[0],
                "max_score": score_range[1],
                "source_requirement_ids": [f"REQ-{index + 2:03d}"],
            }
            for index, score_range in enumerate(bonus_ranges, start=1)
        ],
        "penalty_rules": [
            {
                "id": "PEN-001",
                "text": "答非所问直接掉到60-70分",
                "effect": "set_range",
                "min_score": 60,
                "max_score": 70,
                "source_requirement_ids": ["REQ-010"],
            },
            {
                "id": "PEN-002",
                "text": "超时印象分大扣",
                "effect": "qualitative",
                "source_requirement_ids": ["REQ-011"],
            },
        ],
        "score_conflicts": [
            {
                "text": "档位标题最高90分，但基础分与逐项加分上限合计为97分",
                "source_requirement_ids": ["REQ-012", "REQ-013"],
            }
        ],
        "normalization": {
            "raw_max_score": 97,
            "target_max_score": 100,
            "method": "linear",
        },
    }
    return candidate
