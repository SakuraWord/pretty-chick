"""
Fundval 项目初始化

确保 Celery 应用在 Django 启动时加载
"""

# PyMySQL 兼容：让 Django 的 mysql backend 使用 PyMySQL 驱动
import pymysql

pymysql.install_as_MySQLdb()

# 导入 Celery 应用，确保在 Django 启动时加载
from .celery import app as celery_app

__all__ = ("celery_app",)
