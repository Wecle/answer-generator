from app.services.document_parser import parse_question_paragraphs


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
