from __future__ import annotations


class AIProviderError(Exception):
    """Base error for AI provider interactions."""


class AIProviderUnavailable(AIProviderError):
    """The configured provider is not installed / enabled / reachable."""


class AITimeoutError(AIProviderError):
    """The provider call exceeded the configured timeout."""


class AICommandError(AIProviderError):
    """The provider exited with an error (stderr, non-zero exit)."""

    def __init__(self, message: str, returncode: int | None = None, stderr: str = "") -> None:
        self.returncode = returncode
        self.stderr = stderr
        super().__init__(message)


class AISchemaValidationError(AIProviderError):
    """AI returned content that could not be parsed / validated."""

    def __init__(self, message: str, raw_output: str = "") -> None:
        self.raw_output = raw_output
        super().__init__(message)
