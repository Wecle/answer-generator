from app.services.document_parser import _questions_from_ai_data, parse_question_paragraphs


def test_parse_question_paragraphs_groups_material_and_questions():
    questions = parse_question_paragraphs(
        [
            "材料：某市开展老旧小区改造。",
            "居民对停车、加装电梯有不同意见。",
            "1、请谈谈你如何协调各方意见？",
            "2、如何保障改造工作顺利推进？",
        ]
    )

    assert len(questions) == 2
    assert questions[0].material is not None
    assert questions[0].question == "请谈谈你如何协调各方意见？"


def test_parse_question_paragraphs_detects_title_material_and_multiple_questions():
    questions = parse_question_paragraphs(
        [
            "2025年4月28日宁夏区考面试题",
            "材料：某地推进全方位全过程监督管理。",
            "问题 1",
            "请谈谈你的看法，并说说有什么金点子？",
            "问题 2",
            "（论述题）请选择其中三个问题并提出建议。",
            "问题 3",
            "你作为社区工作者会怎么办？",
        ]
    )

    assert len(questions) == 1
    assert questions[0].title == "2025年4月28日宁夏区考面试题"
    assert questions[0].material == "某地推进全方位全过程监督管理。"
    assert "问题 1" in questions[0].question
    assert "问题 3" in questions[0].question


def test_questions_from_ai_data_normalizes_valid_items():
    questions = _questions_from_ai_data(
        {
            "questions": [
                {
                    "title": "2025年4月28日宁夏区考面试题",
                    "material": "某地推进农产品质量监管。",
                    "question": "问题 1\n请谈谈你的看法。",
                },
                {"title": "", "material": "", "question": "请提出解决建议。"},
                {"title": "空题", "material": "无", "question": ""},
            ]
        }
    )

    assert len(questions) == 2
    assert questions[0].title == "2025年4月28日宁夏区考面试题"
    assert questions[0].material == "某地推进农产品质量监管。"
    assert questions[1].title is None
    assert questions[1].material is None
